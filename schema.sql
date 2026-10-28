-- =====================================================================
-- SORS — fonction d'import des événements externes (bdxc.fr, etc.)
-- À coller dans Supabase > SQL Editor. Ne crée AUCUNE table : utilise
-- events, event_occurrences, venues et event_source_aliases existantes.
-- =====================================================================

-- (Recommandé) empêche deux événements avec la même source + source_id.
-- Si cette ligne échoue, c'est que tu as déjà des doublons : envoie-moi l'erreur.
create unique index if not exists events_source_source_id_uidx
  on public.events (source, source_id);

create or replace function public.import_external_events(
  p_source        text,
  p_events        jsonb,
  p_horizon_days  int default 21
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  -- ⚙ Valeurs à aligner sur tes contraintes CHECK (voir la requête en bas du fichier)
  c_statut_publie  constant text := 'publie';
  c_statut_annule  constant text := 'annule';
  c_duree_defaut   constant interval := interval '3 hours';
  c_heure_defaut   constant text := '20:00';

  e jsonb; o jsonb;
  v_venue uuid; v_event uuid; v_src text; v_locked boolean;
  v_debut timestamptz; v_first timestamptz; v_keep timestamptz[];
  n_new int := 0; n_upd int := 0; n_dup int := 0; n_locked int := 0; n_venues int := 0; n_skip int := 0;
begin
  for e in select * from jsonb_array_elements(p_events) loop

    -- 1. LIEU : id fourni par le script, sinon même nom + ville, sinon création
    v_venue := nullif(e->>'venue_id', '')::uuid;
    if v_venue is null then
      select id into v_venue from venues
       where lower(nom) = lower(e#>>'{venue,nom}') and lower(ville) = lower(e#>>'{venue,ville}')
       limit 1;
      if v_venue is null then
        if e#>>'{venue,lat}' is null then n_skip := n_skip + 1; continue; end if;
        insert into venues (nom, adresse, ville, geo, created_at)
        values (e#>>'{venue,nom}', coalesce(e#>>'{venue,adresse}', ''), e#>>'{venue,ville}',
                ST_SetSRID(ST_MakePoint((e#>>'{venue,lng}')::float8, (e#>>'{venue,lat}')::float8), 4326)::geography,
                now())
        returning id into v_venue;
        n_venues := n_venues + 1;
      end if;
    end if;

    -- 2. ÉVÉNEMENT DÉJÀ CONNU ? (alias, puis source + source_id)
    v_event := null;
    select event_id into v_event from event_source_aliases
     where source = p_source and source_id = e->>'source_id';
    if v_event is null then
      select id into v_event from events
       where source = p_source and source_id = e->>'source_id';
    end if;

    -- 3. DOUBLON D'UNE AUTRE SOURCE ? même lieu, ±2h, même mot-clé dans le titre
    --    → on ne crée rien, on mémorise juste l'alias. La saisie manuelle / communauté garde la main.
    if v_event is null then
      select oc.event_id into v_event
        from event_occurrences oc join events ev on ev.id = oc.event_id
       where ev.venue_id = v_venue
         and ev.source <> p_source
         and lower(ev.titre) like '%' || lower(e->>'match_key') || '%'
         and exists (
           select 1 from jsonb_array_elements(e->'occurrences') x
            where abs(extract(epoch from oc.debut -
                  (((x->>'date') || ' ' || coalesce(x->>'heure', c_heure_defaut))::timestamp at time zone 'Europe/Paris'))) <= 7200)
       limit 1;
      if v_event is not null then
        insert into event_source_aliases (event_id, source, source_id, created_at)
        values (v_event, p_source, e->>'source_id', now()) on conflict do nothing;
        n_dup := n_dup + 1;
        continue;
      end if;
    end if;

    -- première date de cette fiche
    select min((((x->>'date') || ' ' || coalesce(x->>'heure', c_heure_defaut))::timestamp at time zone 'Europe/Paris'))
      into v_first from jsonb_array_elements(e->'occurrences') x;

    -- 4. CRÉATION ou MISE À JOUR
    if v_event is null then
      insert into events (titre, description, type, venue_id, debut, fin,
                          prix_min, prix_max, gratuit, image_url, lien_billetterie,
                          source, source_id, statut, tags, vues, moderation_locked, created_at)
      values (e->>'titre', '', e->>'type', v_venue, v_first, v_first + c_duree_defaut,
              (e->>'prix_min')::numeric, (e->>'prix_max')::numeric, coalesce((e->>'gratuit')::boolean, false),
              e->>'image_url', e->>'lien_billetterie',
              p_source, e->>'source_id',
              case when (e->>'annule')::boolean then c_statut_annule else c_statut_publie end,
              coalesce(array(select jsonb_array_elements_text(e->'tags')), '{}'), 0, false, now())
      returning id into v_event;
      insert into event_source_aliases (event_id, source, source_id, created_at)
      values (v_event, p_source, e->>'source_id', now()) on conflict do nothing;
      n_new := n_new + 1;
    else
      select source, moderation_locked into v_src, v_locked from events where id = v_event;
      if v_src <> p_source then n_dup := n_dup + 1; continue; end if;   -- appartient à une autre source
      if coalesce(v_locked, false) then n_locked := n_locked + 1; continue; end if; -- verrouillé par la modération
      update events set
        titre            = e->>'titre',
        venue_id         = v_venue,
        prix_min         = (e->>'prix_min')::numeric,
        prix_max         = (e->>'prix_max')::numeric,
        gratuit          = coalesce((e->>'gratuit')::boolean, false),
        image_url        = coalesce(e->>'image_url', image_url),
        lien_billetterie = coalesce(e->>'lien_billetterie', lien_billetterie),
        tags             = coalesce(array(select jsonb_array_elements_text(e->'tags')), '{}'),
        -- on ne touche au statut que pour publier/annuler : une décision de modération (refus…) est conservée
        statut = case
                   when (e->>'annule')::boolean then c_statut_annule
                   when statut = c_statut_annule then c_statut_publie
                   else statut
                 end
      where id = v_event;
      n_upd := n_upd + 1;
    end if;

    -- 5. OCCURRENCES : ajoute les nouvelles dates
    v_keep := '{}';
    for o in select * from jsonb_array_elements(e->'occurrences') loop
      v_debut := ((o->>'date') || ' ' || coalesce(o->>'heure', c_heure_defaut))::timestamp at time zone 'Europe/Paris';
      v_keep := v_keep || v_debut;
      if not exists (select 1 from event_occurrences where event_id = v_event and debut = v_debut) then
        insert into event_occurrences (event_id, debut, fin) values (v_event, v_debut, v_debut + c_duree_defaut);
      end if;
    end loop;

    -- retire les dates futures (dans la fenêtre scrapée) qui ont disparu du site, sauf si des gens sont inscrits
    delete from event_occurrences oc
     where oc.event_id = v_event
       and oc.debut > now()
       and oc.debut < now() + make_interval(days => p_horizon_days)
       and oc.debut <> all (v_keep)
       and not exists (select 1 from attendances a where a.occurrence_id = oc.id)
       and not exists (select 1 from open_mic_queue q where q.occurrence_id = oc.id);

    -- debut/fin de l'événement = première/dernière occurrence
    update events ev set
      debut = s.d, fin = s.f
      from (select min(debut) d, max(fin) f from event_occurrences where event_id = v_event) s
     where ev.id = v_event and s.d is not null;

  end loop;

  return jsonb_build_object('crees', n_new, 'mis_a_jour', n_upd, 'doublons_autre_source', n_dup,
                            'verrouilles', n_locked, 'nouveaux_lieux', n_venues, 'ignores', n_skip);
end;
$$;

-- Seul le script (clé service_role) peut appeler la fonction
revoke all on function public.import_external_events(text, jsonb, int) from public, anon, authenticated;
grant execute on function public.import_external_events(text, jsonb, int) to service_role;


-- =====================================================================
-- À LANCER AVANT : vérifie les valeurs autorisées (type, statut, source)
-- et les valeurs par défaut. Si 'concert', 'bdxc' ou 'annule' ne sont pas
-- acceptés, adapte c_statut_annule ci-dessus / EVENT_TYPE dans le workflow.
-- =====================================================================
-- select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid in ('public.events'::regclass, 'public.venues'::regclass, 'public.event_source_aliases'::regclass)
--    and contype in ('c', 'u', 'f');
--
-- select table_name, column_name, column_default
--   from information_schema.columns
--  where table_schema = 'public' and table_name in ('events', 'venues', 'event_occurrences', 'event_source_aliases')
--    and column_default is not null;
