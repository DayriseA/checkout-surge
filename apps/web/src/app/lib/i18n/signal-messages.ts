export const signalMessages: Record<string, string> = {
  "Measured from the moment a reservation is secured to final simulated-ERP confirmation.":
    "Mesuré entre la réservation du stock et la confirmation finale par l’ERP simulé.",
  "not yet available": "pas encore disponible",
  "an unrecorded time": "date non enregistrée",
  "Final, as of": "Valeurs finales, relevé :",
  "As of": "Relevé :",
  "· no active run": "· aucune simulation active",
  Updated: "Mise à jour :",
  "· connecting to live updates": "· connexion aux mises à jour en direct",
  "· disconnected, showing last known values": "· déconnecté, dernières valeurs connues affichées",
  "· live": "· en direct",
  "· connected, no update expected": "· connecté, aucune mise à jour attendue",
  "· stale, showing last known values": "· données obsolètes, dernières valeurs connues affichées",
  "· live updates unsupported": "· mises à jour en direct non prises en charge",
  "Unavailable until operator recovery completes":
    "Indisponible jusqu’à la fin de la récupération par l’opérateur",
  "No run has started": "Aucune simulation n’a démarré",
  "Current state": "État actuel",
  "Run availability and updates": "Disponibilité des simulations et mises à jour",
  "Current scenario": "Scénario actuel",
  Run: "Simulation",
  "Load generator": "Générateur de charge",
  Updates: "Mises à jour",
  "Unable to restore live updates. Reload the page. If the problem persists, try again later.":
    "Impossible de rétablir les mises à jour en direct. Rechargez la page. Si le problème persiste, réessayez plus tard.",
  "Reload page": "Recharger la page",
  "Live updates interrupted. Trying to reconnect...":
    "Mises à jour en direct interrompues. Tentative de reconnexion…",
  "Request surge": "Afflux de requêtes",
  "Traffic arrival and responses": "Arrivée du trafic et réponses",
  "No run has started.": "Aucune simulation n’a démarré.",
  "Waiting for the load generator": "En attente du générateur de charge",
  "Not recorded for this run": "Non enregistré pour cette simulation",
  "Peak request arrival rate ({v0})": "Pic d’arrivée des requêtes ({v0})",
  "Request arrival rate ({v0})": "Débit d’arrivée des requêtes ({v0})",
  "Attempts dispatched": "Tentatives envoyées",
  "Dispatch duration": "Durée d’envoi",
  "Response completion rate ({v0})": "Débit des réponses terminées ({v0})",
  "Configured start delay": "Délai de démarrage configuré",
  "Startup overhead beyond configured delay": "Temps de démarrage supplémentaire",
  "Time until checkout attempts begin": "Délai avant les premières tentatives d’achat",
  "Response latency ({v0}; mean)": "Latence des réponses ({v0} ; moyenne)",
  "not measurable": "non mesurable",
  "HTTP failure rate ({v0}; {v1})": "Taux d’échec HTTP ({v0} ; {v1})",
  "Peak reservation rate ({v0}; {v1})": "Pic de réservations ({v0} ; {v1})",
  "Reservations in {v0}": "Réservations sur la {v0}",
  "Waiting for inventory evidence": "En attente des données de stock",
  "Arrival counts checkout attempts when the load generator starts them. Response completion and latency are separate HTTP observations aggregated per":
    "Les arrivées comptent les tentatives d’achat au moment où le générateur les démarre. La fin des réponses et leur latence sont des observations HTTP distinctes, agrégées par",
  "; failure observations use the same window over":
    " ; les échecs utilisent la même fenêtre, appliquée aux",
  "No completed arrival windows yet.": "Aucune fenêtre d’arrivée terminée pour l’instant.",
  "No arrival windows were recorded for this run.":
    "Aucune fenêtre d’arrivée enregistrée pour cette simulation.",
  "Final request totals appear here once all planned attempts have been dispatched.":
    "Les totaux définitifs apparaîtront ici une fois toutes les tentatives prévues envoyées.",
  "Final request totals were not recorded for this run.":
    "Les totaux définitifs n’ont pas été enregistrés pour cette simulation.",
  "Inventory drain": "Épuisement du stock",
  Inventory: "Stock",
  "Remaining inventory": "Stock restant",
  Remaining: "Restant",
  Reserved: "Réservé",
  "Oldest pending": "Plus longue attente",
  "Stock last changed": "Dernier changement du stock",
  "Stock observed": "Stock observé",
  "No inventory evidence yet.": "Aucune donnée de stock pour l’instant.",
  "Inventory evidence is unavailable for this run.":
    "Données de stock indisponibles pour cette simulation.",
  "This run": "Cette simulation",
  "Simulated ERP outcomes": "Résultats de l’ERP simulé",
  "Attempts, failures, and timeouts over the last {v0}s.":
    "Tentatives, échecs et délais dépassés sur les {v0} dernières secondes.",
  "Recent attempts": "Tentatives récentes",
  Failures: "Échecs",
  "{v0} (retried; no order failed)": "{v0} (appels relancés ; aucune commande en échec)",
  Timeouts: "Délais dépassés",
  "Latest attempt": "Dernière tentative",
  "{v0} at {v1}": "{v0} à {v1}",
  "No attempt was recorded for this run": "Aucune tentative enregistrée pour cette simulation",
  "No simulated ERP evidence yet.": "Aucune donnée de l’ERP simulé pour l’instant.",
  "Simulated ERP evidence is unavailable for this run.":
    "Données de l’ERP simulé indisponibles pour cette simulation.",
  "Shared demo runtime": "Infrastructure partagée de la démo",
  "Physical order queue": "File de commandes physique",
  "In this run the order queue is in PostgreSQL: each order not yet confirmed waits there, counted from the run's order records.":
    "Dans cette simulation, la file de commandes est dans PostgreSQL : chaque commande non confirmée y attend, comptée d’après les commandes enregistrées de la simulation.",
  "Live BullMQ counts for the one shared order queue; global technical context, not evidence for the selected run.":
    "Compteurs BullMQ en direct de l’unique file de commandes partagée ; contexte technique global, pas des données de la simulation sélectionnée.",
  "Orders waiting or being confirmed": "Commandes en attente ou en cours de confirmation",
  "Oldest wait": "Plus longue attente",
  "Last updated": "Dernière mise à jour",
  "Shared order-processing backlog": "Commandes en attente sur la démo partagée",
  Connectivity: "Connectivité",
  "Depth (all runs)": "Taille (toutes les simulations)",
  "Backlog details": "Détails des commandes en attente",
  Waiting: "En attente",
  Prioritized: "Prioritaires",
  Paused: "En pause",
  Delayed: "Différées",
  Active: "En cours",
  "Counts include work from all runs and visitors.":
    "Ces compteurs incluent le travail de toutes les simulations et de tous les visiteurs.",
  "Shared demo-runtime status is unavailable.":
    "L’état de l’infrastructure partagée est indisponible.",
  "No confirmations yet": "Aucune confirmation pour l’instant",
  "No confirmations were recorded for this run":
    "Aucune confirmation enregistrée pour cette simulation",
  "Fast reservation vs final confirmation": "Réservation rapide vs confirmation finale",
  "95% confirmed within": "95 % confirmées en moins de",
  Average: "Moyenne",
  Longest: "Maximum",
  Confirmed: "Confirmées",
  Measured: "Mesuré",
  "No confirmation evidence yet.": "Aucune donnée de confirmation pour l’instant.",
  "Confirmation evidence is unavailable for this run.":
    "Données de confirmation indisponibles pour cette simulation.",
  "Reservation and confirmation summary": "Résumé des réservations et confirmations",
  "Queued (awaiting first processing start)": "En file (avant le premier traitement)",
  Processing: "En traitement",
  Retrying: "En relance",
  Failed: "En échec",
  "No checkout outcome evidence yet.": "Aucune donnée sur les résultats d’achat pour l’instant.",
  "Checkout outcome evidence is unavailable for this run.":
    "Résultats d’achat indisponibles pour cette simulation.",
  "Sale evidence": "Données de la vente",
  "Arrival → reservation → backlog → confirmation":
    "Arrivée → réservation → commandes en attente → confirmation",
  Settled: "Finalisées",
  "All panels cover the {v0} from its first checkout attempt to its final timeline boundary.":
    "Tous les panneaux couvrent {v0}, de sa première tentative d’achat à la fin de sa chronologie.",
  "The timeline panels cover the {v0} through its final timeline boundary; request-arrival evidence was not recorded.":
    "Les panneaux couvrent {v0} jusqu’à la fin de sa chronologie ; les arrivées des requêtes n’ont pas été enregistrées.",
  "Final timeline evidence was not recorded; the run evidence that was recorded is shown where available.":
    "La chronologie finale n’a pas été enregistrée ; les données disponibles de la simulation sont affichées.",
  "Live panels show the available run updates.":
    "Les panneaux en direct affichent les mises à jour disponibles de la simulation.",
  "Request arrival timeline": "Chronologie des arrivées",
  "Checkout attempts started by the load generator in {v0} windows.":
    "Tentatives d’achat démarrées par le générateur, par fenêtres {v0}.",
  Arrivals: "Arrivées",
  "Request arrival": "Arrivée des requêtes",
  "Processing backlog timeline": "Chronologie des commandes en attente",
  "Reserved orders waiting for their first processing start.":
    "Commandes réservées en attente de leur premier traitement.",
  "Drain duration runs from the first queued order to final backlog zero. Run-owned retrying orders are counted separately ({v0}) because retries can return to processing without re-entering this backlog.":
    "La durée de résorption va de la première commande en file au retour définitif à zéro commande en attente. Les commandes en relance de la simulation sont comptées à part ({v0}) : elles peuvent repartir en traitement sans revenir parmi les commandes en attente.",
  Backlog: "Commandes en attente",
  "Processing backlog": "Commandes en attente de traitement",
  "Confirmation timeline": "Chronologie des confirmations",
  "Cumulative confirmed orders; settled adds failed orders.":
    "Commandes confirmées cumulées ; les commandes finalisées incluent les échecs.",
  "Cumulative confirmed orders.": "Commandes confirmées cumulées.",
  "Reservation-to-confirmation time is elapsed from reservation secured to final confirmation.":
    "Le délai entre réservation et confirmation va de la réservation du stock à la confirmation finale.",
  "Reservation-to-confirmation": "Réservation à confirmation",
  "Orders over time": "Commandes au fil du temps",
  "The order timeline was not recorded for this run.":
    "La chronologie des commandes n’a pas été enregistrée pour cette simulation.",
  "Reserved orders waiting to be processed, and orders confirmed so far.":
    "Commandes réservées en attente de traitement et commandes déjà confirmées.",
  "Shared axis: 0s {v0} · {v1} {v2}": "Axe commun : 0 s {v0} · {v1} {v2}",
  "first checkout attempt": "première tentative d’achat",
  "final timeline boundary": "fin de la chronologie",
  "retained run update": "mise à jour conservée de la simulation",
  "available update": "mise à jour disponible",
  "latest {v0}": "dernière {v0}",
  "last recorded arrival window": "dernière fenêtre d’arrivée enregistrée",
  "first {v0}": "première {v0}",
  "completed run": "la simulation terminée",
  "failed run": "la simulation en échec",
  "recorded run window": "la fenêtre enregistrée de la simulation",
  "Stock depleted": "Stock épuisé",
  "Last checkout attempt": "Dernière tentative d’achat",
  "Backlog drained": "Plus aucune commande en attente",
  Confirmation: "Confirmation",
  "1 · Arrival": "1 · Arrivée",
  Dispatched: "Envoyées",
  Responses: "Réponses",
  "Latency (mean)": "Latence (moyenne)",
  "HTTP failures": "Échecs HTTP",
  "2 · Stock": "2 · Stock",
  "of {v0} left": "restantes sur {v0}",
  "Sold-out rejections": "Refus pour rupture de stock",
  Oversold: "Survendues",
  "Awaiting storage": "En attente de persistance",
  "3 · Processing": "3 · Traitement",
  "ERP fail / timeout": "ERP : échecs / délais dépassés",
  "ERP protection": "Protection de l’ERP",
  "Downstream ERP": "ERP en aval",
  "Status unavailable": "État indisponible",
  "4 · Confirmation": "4 · Confirmation",
  "of {v0} confirmed": "confirmées sur {v0}",
  "Confirmation rate ({v0})": "Débit de confirmation ({v0})",
  "Confirmation rate": "Débit de confirmation",
  Pending: "En attente",
  "Failed orders": "Commandes en échec",
  "p95 · avg": "p95 · moy.",
  "changed in the last update": "modifié à la dernière mise à jour",
  "Planned attempts": "Tentatives prévues",
  "Replies recorded": "Réponses enregistrées",
  "Generator received no reply": "Aucune réponse reçue par le générateur",
  "Replies not recorded": "Réponses non enregistrées",
  "Never dispatched": "Jamais envoyées",
  "load generator stopped before the reply arrived": "le générateur s’est arrêté avant la réponse",
  "connection failed before a reply": "échec de connexion avant toute réponse",
  "scenario window closed before these were sent":
    "la fenêtre du scénario s’est fermée avant leur envoi",
  "observed replies only": "réponses observées uniquement",
  "Outcomes and latency cover {v0} of {v1} attempts.":
    "Les résultats et la latence couvrent {v0} tentatives sur {v1}.",
  "Reply-dependent outcomes and latency cover {v0} of {v1} attempts. The HTTP failure rate above is a separate load-generator measure and can include connection failures. Durable checkout records below are the authoritative record.":
    "Les résultats dépendant d’une réponse et la latence couvrent {v0} tentatives sur {v1}. Le taux d’échec HTTP ci-dessus est une mesure distincte du générateur et peut inclure les échecs de connexion. Les enregistrements d’achat durables ci-dessous font foi.",
  "Outcomes and latency above cover {v0} of {v1} attempts. The p95 describes replies received only. Durable checkout records are the authoritative record.":
    "Les résultats et la latence ci-dessus couvrent {v0} tentatives sur {v1}. Le p95 ne décrit que les réponses reçues. Les enregistrements d’achat durables font foi.",
  "Load-generator outcomes": "Résultats du générateur de charge",
  Unexpected: "Inattendues",
  "Checkout response p95 (client-observed)": "p95 des réponses d’achat (côté client)",
  "Inventory reservation": "Réservation du stock",
  "Inventory reservation start → reservation decision received":
    "Début de la réservation → décision de réservation reçue",
  "Observed reservation p95": "p95 de réservation observé",
  "bounded p95 estimate": "estimation bornée du p95",
  "Reservation processing p95 bound": "Borne du p95 de traitement de réservation",
  "bounded p95 estimate; service entry → response ready":
    "estimation bornée du p95 ; entrée du service → réponse prête",
  "Environment note:": "Environnement :",
  "this run was hosted, with the load generator on its own machine in region":
    "cette simulation était hébergée, avec le générateur sur une machine distincte dans la région",
  "this run was local, with the load generator, API, database, order-processing service, and simulated ERP on one host.":
    "cette simulation était locale, avec le générateur, l’API, la base de données, le service de traitement et l’ERP simulé sur un même hôte.",
  "These figures record one run in one environment, not a benchmark.":
    "Ces chiffres décrivent une simulation dans un environnement donné, pas un benchmark.",
  "Observed response timing": "Temps de réponse observés",
  "Load-generator timing; waiting includes server and dependency queueing":
    "Mesures du générateur ; l’attente inclut les files du serveur et de ses dépendances",
  "Waiting p95": "Attente p95",
  "Blocked p95": "Blocage p95",
  "Connecting p95": "Connexion p95",
  "Sending p95": "Envoi p95",
  "Receiving p95": "Réception p95",
  "TLS handshake p95": "Négociation TLS p95",
  "checkout attempts started by the load generator":
    "tentatives d’achat démarrées par le générateur",
  "Peak ({v0} window)": "Pic (fenêtre {v0})",
  "{v0} attempts/s": "{v0} tentatives/s",
  "Checkout dispatch duration (observed)": "Durée d’envoi des achats (observée)",
  "No checkout attempt was recorded for this run.":
    "Aucune tentative d’achat enregistrée pour cette simulation.",
  "Request arrival time series": "Série temporelle des arrivées",
  "Observation coverage": "Couverture des observations",
  "% of dispatched attempts recorded a reply":
    " % des tentatives envoyées ont une réponse enregistrée",
  Unavailable: "Indisponible",
  "Not recorded": "Non enregistré",
  "With and without the order queue, on the same workload":
    "Avec et sans file de commandes, à charge égale",
  "Winners' time to an answer, average / 95th percentile (all winners)":
    "Délai de réponse des gagnants, moyenne / 95e percentile (tous les gagnants)",
  "Every buyer had an answer within": "Tous les acheteurs ont reçu une réponse en moins de",
  "Winners told “confirmed” / “secured, not yet confirmed”":
    "Gagnants ayant reçu « confirmé » / « réservé, pas encore confirmé »",
  "Buyers without an expected answer": "Acheteurs sans réponse attendue",
  "Orders confirmed by the ERP (failed)": "Commandes confirmées par l’ERP (en échec)",
  "ERP pace, from the first buyer to the last confirmation (limit {v0} per second)":
    "Débit ERP, du premier acheteur à la dernière confirmation (limite de {v0} par seconde)",
  "Slowest order, from secured to confirmed":
    "Commande la plus lente, de la réservation à la confirmation",
  "Stock decided in Redis, then in PostgreSQL, on the same workload":
    "Stock décidé dans Redis, puis dans PostgreSQL, à charge égale",
  "Buyers secured / turned away / without an expected answer":
    "Gagnants / refusés / sans réponse attendue",
  "Units sold, of the stock": "Unités vendues, sur le stock",
  "{v0} of {v1}": "{v0} sur {v1}",
  "PostgreSQL transactions": "Transactions PostgreSQL",
  "PostgreSQL CPU time": "Temps CPU PostgreSQL",
  "Time spent in PostgreSQL queries, waits for the stock row included":
    "Temps des requêtes PostgreSQL, attente sur la ligne de stock comprise",
  "Winners' time to an answer, average / 95th percentile":
    "Délai de réponse des gagnants, moyenne / 95e percentile",
  "Turned-away buyers' time to an answer, average / 95th percentile":
    "Délai de réponse des acheteurs refusés, moyenne / 95e percentile",
  "How to read these figures": "Lire ces chiffres",
  "What this comparison does not show": "Ce que cette comparaison ne montre pas",
  "In progress: results appear when the run ends.":
    "En cours : les résultats apparaîtront à la fin de la simulation.",
  "Report not available.": "Rapport indisponible.",
  "Starts after run 1.": "Démarre après la simulation 1.",
  "No second run was started.": "Aucune seconde simulation n’a démarré.",
  "This run did not complete; see its report.":
    "Cette simulation n’a pas abouti ; consultez son rapport.",
  "{v0} vs run 1": "{v0} vs simulation 1",
  "View this run's report": "Voir le rapport de cette simulation",
  "Could not determine": "Impossible à déterminer",
  "Generator diagnostics": "Diagnostics du générateur",
  "warnings ·": "avertissements ·",
  "stderr retained ·": "lignes stderr conservées ·",
  "not truncated": "non tronquées",
  "unavailable probes ·": "sondes indisponibles ·",
  "fallback metric sources": "sources de mesures de secours",
  "Generator diagnostics were unavailable for this run.":
    "Diagnostics du générateur indisponibles pour cette simulation.",
  "Generator host": "Hôte du générateur",
  "Generator CPU scope differs: {v0} host logical CPUs; {v1} cgroup CPU quota.":
    "Les périmètres CPU diffèrent : {v0} processeurs logiques de l’hôte ; quota CPU cgroup de {v1}.",
  "Generator host logical CPUs": "Processeurs logiques de l’hôte du générateur",
  "Generator process ulimit -n": "Limite ulimit -n du processus du générateur",
  "k6 process open-files soft limit": "Limite souple des fichiers ouverts de k6",
  "k6 process open-files hard limit": "Limite stricte des fichiers ouverts de k6",
  "Generator capacity": "Capacité du générateur",
  "Generator host total memory": "Mémoire totale de l’hôte du générateur",
  "Generator host available memory": "Mémoire disponible de l’hôte du générateur",
  "Generator host swap": "Swap de l’hôte du générateur",
  "Generator cgroup memory limit": "Limite mémoire cgroup du générateur",
  "Generator cgroup CPU quota": "Quota CPU cgroup du générateur",
  "Generator utilisation": "Utilisation du générateur",
  "k6 process peak RSS": "Pic RSS du processus k6",
  "Generator cgroup peak memory": "Pic mémoire cgroup du générateur",
  "Generator host minimum available memory": "Mémoire disponible minimale de l’hôte du générateur",
  "k6 process peak CPU utilisation": "Pic d’utilisation CPU du processus k6",
  "k6 process mean CPU utilisation": "Utilisation CPU moyenne du processus k6",
  "Generator cgroup peak swap": "Pic de swap cgroup du générateur",
  "Generator cgroup memory high events": "Événements memory.high du cgroup du générateur",
  "Not applicable": "Sans objet",
  "Generator cgroup memory max events": "Événements memory.max du cgroup du générateur",
  "Generator cgroup OOM kills": "Arrêts OOM du cgroup du générateur",
  "Generator utilisation samples": "Échantillons d’utilisation du générateur",
  "Generator sampling interval": "Intervalle d’échantillonnage du générateur",
  "Generator network": "Réseau du générateur",
  "Generator local TCP port range": "Plage de ports TCP locaux du générateur",
  "Generator tcp_tw_reuse": "tcp_tw_reuse du générateur",
  "Generator tcp_timestamps": "tcp_timestamps du générateur",
  "k6 traffic mode": "Mode de trafic k6",
  "buyer spike": "afflux simultané d’acheteurs",
  "k6 buyer count": "Nombre d’acheteurs k6",
  "k6 duplicate each buyer attempt": "Tentative de chaque acheteur doublée dans k6",
  "k6 iterations per VU": "Itérations par utilisateur virtuel k6",
  "k6 planned emitted attempts": "Tentatives d’envoi prévues dans k6",
  "k6 start delay": "Délai de démarrage k6",
  "k6 maximum duration": "Durée maximale k6",
  "constant arrival rate": "débit d’arrivée constant",
  "k6 scheduled rate": "Débit planifié k6",
  "k6 duration": "Durée k6",
  "k6 pre-allocated VUs": "Utilisateurs virtuels préalloués k6",
  "k6 maximum VUs": "Nombre maximal d’utilisateurs virtuels k6",
  "k6 process": "Processus k6",
  "k6 started": "Démarrage k6",
  "k6 completed": "Fin k6",
  "k6 version": "Version k6",
  "k6 started-request source": "Source des requêtes démarrées k6",
  "k6 completed-request source": "Source des requêtes terminées k6",
  "k6 accepted-response source": "Source des réponses acceptées k6",
  "k6 sold-out-response source": "Source des réponses de rupture k6",
  "k6 transport-failure source": "Source des échecs de transport k6",
  "k6 unexpected-response source": "Source des réponses inattendues k6",
  "k6 dropped-iteration source": "Source des itérations abandonnées k6",
  "k6 completed-iteration source": "Source des itérations terminées k6",
  "k6 terminal metric sources": "Sources des mesures finales k6",
  "k6 summary-export warnings": "Avertissements de l’export récapitulatif k6",
  "k6 metric provenance": "Origine des mesures k6",
  "Live metric stream": "Flux de mesures en direct",
  "Only the live dashboard can miss these; the final report does not.":
    "Seul le dashboard live peut en manquer ; le rapport final reste complet.",
  "Runner dropped live metric batches": "Lots de mesures en direct abandonnés par le lanceur",
  "Runner dropped live metric samples":
    "Échantillons de mesures en direct abandonnés par le lanceur",
  "API dropped live metric batches": "Lots de mesures en direct abandonnés par l’API",
  "k6 stderr": "Sortie stderr k6",
  "k6 stderr lines observed": "Lignes stderr k6 observées",
  "k6 stderr lines retained": "Lignes stderr k6 conservées",
  "k6 stderr retained-line limit": "Limite de lignes stderr k6 conservées",
  "k6 stderr line-length limit": "Longueur maximale des lignes stderr k6",
  "{v0} characters": "{v0} caractères",
  "k6 stderr lines truncated": "Lignes stderr k6 tronquées",
  "No retained generator stderr lines.": "Aucune ligne stderr du générateur conservée.",
  "{v0} bytes": "{v0} octets",
  Unlimited: "Illimité",
  "k6 summary export": "Export récapitulatif k6",
  "retained point-stream fallback": "flux de points conservé en secours",
  "The k6 summary export was not present.": "L’export récapitulatif k6 était absent.",
  "The k6 summary export could not be validated.":
    "L’export récapitulatif k6 n’a pas pu être validé.",
  "The k6 summary export could not be read.": "L’export récapitulatif k6 n’a pas pu être lu.",
  "A retained point stream supplied an outcome counter.":
    "Un flux de points conservé a fourni un compteur de résultats.",
  "A k6 outcome counter was unavailable from the summary export.":
    "Un compteur de résultats k6 était absent de l’export récapitulatif.",
  "Failure explanation": "Explication de l’échec",
  "The server still handled {v0}: {v1} secured and its order confirmed and notified. Only {v2} took too long. ":
    "Le serveur a bien traité {v0} : {v1} obtenue et sa commande confirmée et notifiée. Seul le délai de {v2} était trop long. ",
  "that request": "cette requête",
  "those requests": "ces requêtes",
  "the only reservation was": "l’unique réservation a été",
  "every one of the {v0} reservations was": "chacune des {v0} réservations a été",
  "its answer": "sa réponse",
  "their answers": "leurs réponses",
  "The server may still have handled {v0}: a timeout only means that no answer arrived in time. ":
    "Le serveur a peut-être quand même traité {v0} : un délai dépassé signifie seulement qu’aucune réponse n’est arrivée à temps. ",
  "This request": "cette requête",
  "These requests": "ces requêtes",
  "The server still handled {v0}: {v1} secured and its order confirmed and notified. Only {v2} came too late to be recorded. ":
    "Le serveur a bien traité {v0} : {v1} obtenue et sa commande confirmée et notifiée. Seule l’arrivée de {v2} était trop tardive pour être enregistrée. ",
  "This buyer": "cet acheteur",
  "These buyers": "ces acheteurs",
  "Unexpected responses recorded:": "Réponses inattendues enregistrées :",
  "ended in transport failure.": "en échec de transport.",
  ", including {v0} whose answer arrived too late":
    ", y compris {v0} dont la réponse est arrivée trop tard",
  "the one": "celle",
  "Business outcomes:": "Résultats métier :",
  "All sent requests completed. No transport failures or unexpected responses were recorded.":
    "Toutes les requêtes envoyées se sont terminées. Aucun échec de transport ni réponse inattendue n’a été enregistré.",
  "What to check next": "À vérifier ensuite",
  "Why this diagnosis?": "Pourquoi ce diagnostic ?",
  "HTTP response latency, p95": "Latence de réponse HTTP, p95",
  "Connection time, p95": "Temps de connexion, p95",
  "Recorded k6 output": "Sortie k6 enregistrée",
  "Measurement coverage": "Couverture des mesures",
  "completed attempt": "tentative terminée",
  "{v0}; outcomes and latency cover only the recorded answers.":
    "{v0} ; les résultats et la latence couvrent uniquement les réponses enregistrées.",
  "Outcomes and latency cover only the recorded answers.":
    "Les résultats et la latence couvrent uniquement les réponses enregistrées.",
  "{v0} planned {v1} never sent.": "Requêtes prévues jamais envoyées : {v0}.",
  "request was": "requête",
  "requests were": "requêtes",
  "Virtual user limit reached": "Limite d’utilisateurs virtuels atteinte",
  "The load generator reached its limit of {v0} concurrent {v1} and could not maintain the requested traffic rate.":
    "Le générateur a atteint sa limite de {v0} {v1} simultanés et n’a pas pu maintenir le débit demandé.",
  "virtual user": "utilisateur virtuel",
  "For the same traffic target, investigate slow responses and review virtual-user capacity. A lower request rate would test a less demanding scenario.":
    "À trafic cible égal, analysez les réponses lentes et revoyez la capacité en utilisateurs virtuels. Un débit plus faible testerait un scénario moins exigeant.",
  "The generator explicitly reported that its virtual-user limit was reached. This identifies the delivery limit, but does not establish the exact source of response delays.":
    "Le générateur a explicitement signalé que sa limite d’utilisateurs virtuels était atteinte. Cela identifie la limite d’acheminement, sans établir la cause exacte du délai des réponses.",
  "Answers arrived too late": "Réponses arrivées trop tard",
  "The server needed more time than the load generator waits: {v0} {v1} still waiting for their answer when the generator stopped listening, {v2} seconds after its sending window closed.":
    "Le serveur a eu besoin de plus de temps que le générateur n’en accorde : {v0} {v1} encore en attente d’une réponse quand le générateur a cessé d’écouter, {v2} secondes après la fermeture de sa fenêtre d’envoi.",
  "buyer was": "acheteur était",
  "buyers were": "acheteurs étaient",
  "Accepted orders are the slow path: each one is written to the database before the buyer gets an answer. A lower request rate or less stock lets the server answer everyone in time.":
    "Les commandes acceptées passent par le chemin lent : chacune est écrite en base avant que l’acheteur reçoive sa réponse. Avec un débit plus faible ou moins de stock, le serveur répond à tous à temps.",
  "The load generator sent these requests but stopped listening before their answers arrived. The late answers alone are enough to fail the run, so they explain this failure. The report shows when answers arrived, not where the server spent its time.":
    "Le générateur a envoyé ces requêtes mais a cessé d’écouter avant leurs réponses. Les réponses tardives suffisent à elles seules à faire échouer la simulation : elles expliquent donc cet échec. Le rapport montre quand les réponses sont arrivées, pas où le serveur a passé son temps.",
  "Requests timed out": "Requêtes expirées",
  "{v0} {v1} got no answer within the load generator's {v2}-second limit, so the generator gave up on {v3}.":
    "Le générateur n’a reçu aucune réponse pour {v0} {v1} dans sa limite de {v2} secondes et a donc cessé d’attendre.",
  "Fewer buyers, a smaller burst, or the same traffic spread over more time gives the server room to answer every request within {v0} seconds.":
    "Moins d’acheteurs, un afflux moins important ou le même trafic étalé dans le temps laisse au serveur le temps de répondre à chaque requête en moins de {v0} secondes.",
  "The load generator recorded these requests as timed out: it started each one but did not receive a complete response within {v0} seconds. The timeouts alone are enough to fail the run, so they explain this failure. The report does not show where the server spent that time.":
    "Le générateur a enregistré ces requêtes comme expirées : il a démarré chacune d’elles sans recevoir de réponse complète en {v0} secondes. Ces délais dépassés suffisent à eux seuls à faire échouer la simulation : ils expliquent donc cet échec. Le rapport ne montre pas où le serveur a passé ce temps.",
  "Traffic failed — exact cause not identified": "Échec du trafic — cause exacte non identifiée",
  "The recorded evidence does not identify a specific cause for this traffic failure.":
    "Les données enregistrées n’identifient pas de cause précise pour cet échec du trafic.",
  "Review the recorded traffic measurements and generator diagnostics before retrying. The report does not establish which setting or component caused the failure.":
    "Examinez les mesures du trafic et les diagnostics du générateur avant de réessayer. Le rapport n’établit pas quel réglage ou composant a causé l’échec.",
  "No recognized generator diagnostic explains this failure. Missing or truncated diagnostics cannot establish that no problem occurred.":
    "Aucun diagnostic reconnu du générateur n’explique cet échec. Des diagnostics absents ou tronqués ne prouvent pas l’absence de problème.",
  "Preview unavailable. You can try starting; the server will check admission again.":
    "Aperçu indisponible. Vous pouvez tenter de démarrer : le serveur revérifiera l’admission.",
  Code: "Code",
  "HTTP status": "Statut HTTP",
  Correlation: "Corrélation",
  Reason: "Motif",
  "About {v0}": "À propos de {v0}",
  Confirmations: "Confirmations",
  "{v0} sparkline": "Courbe miniature : {v0}",
  "{v0} over the run: {v1}": "{v0} pendant la simulation : {v1}",
  "Scenario settings": "Paramètres du scénario",
  "What this run was configured to test": "Ce que cette simulation devait tester",
  "Simulated ERP delay": "Délai de l’ERP simulé",
  "No sample": "Aucun échantillon",
  "Download CSV": "Télécharger le CSV",
  "View technical measurements": "Voir les mesures techniques",
  "This run is too close to the demo server's limit to be sure every buyer gets an answer in time.":
    "Cette simulation est trop proche de la limite du serveur de démo pour garantir une réponse à temps à chaque acheteur.",
  "This run is too heavy for the demo's server.":
    "Cette simulation est trop lourde pour le serveur de démo.",
  "A single API process answers every buyer, and each unit sold is first written to the database, which is much slower.":
    "Un seul processus API répond à tous les acheteurs, et chaque unité vendue est d’abord écrite en base, ce qui est beaucoup plus lent.",
  "run the project locally or on larger infrastructure":
    "exécutez le projet localement ou sur une infrastructure plus puissante",
  "These virtual users are fewer than this deployment would allocate for this rate ({v0}); requests may never be sent.":
    "Il y a moins d’utilisateurs virtuels que ce que ce déploiement allouerait pour ce débit ({v0}) ; certaines requêtes risquent de ne jamais partir.",
  " with {v0} in stock": " avec {v0} en stock",
  "the run would use {v0}% of what the server can sustain":
    "la simulation utiliserait {v0} % de la capacité du serveur",
  "the server would fall behind and some buyers would not get their answer in time":
    "le serveur prendrait du retard et certains acheteurs n’auraient pas leur réponse à temps",
  "keeping this stock and duration, the rate can go up to {v0} per second":
    "à stock et durée identiques, le débit peut atteindre {v0} par seconde",
  "keeping this rate, the stock can go up to {v0}":
    "à débit identique, le stock peut atteindre {v0}",
  "the rate": "le débit",
  "the stock": "le stock",
  "At {v0} per second for {v1}{v2}, {v3}.": "À {v0} par seconde pendant {v1}{v2}, {v3}.",
  "Lower {v0}, or {v1}.": "Réduisez {v0}, ou {v1}.",
  "the buyers to {v0}": "le nombre d’acheteurs à {v0}",
  "the stock to {v0}": "le stock à {v0}",
  "Lower {v0}.": "Réduisez {v0}.",
  "raise the safety cutoff to {v0}": "augmentez la limite de sécurité à {v0}",
  "lower {v0}": "réduisez {v0}",
  "With {v0} and {v1}, this server needs about {v2} to answer everyone, {v3} {v4}.":
    "Avec {v0} et {v1}, ce serveur a besoin d’environ {v2} pour répondre à tous, {v3} {v4}.",
  "too close to": "trop près de",
  "more than": "au-delà de",
  "up to {v0} per second": "jusqu’à {v0} par seconde",
  "up to {v0}": "jusqu’à {v0}",
  "Near this deployment's capacity: the run asks about {v0} answers per second, {v1} % of the {v2} one API process gives here.":
    "Près de la capacité de ce déploiement : la simulation demande environ {v0} réponses par seconde, soit {v1} % des {v2} fournies ici par un processus API.",
  "It may complete, with little margin.": "La simulation peut aboutir, mais avec peu de marge.",
  "Beyond this deployment's capacity: about {v0} answers per second against {v1}. Expect a failed delivery: requests never sent at the virtual-user limit, or answers arriving too late.":
    "Au-delà de la capacité de ce déploiement : environ {v0} réponses par seconde contre {v1}. Attendez-vous à un échec de l’acheminement : requêtes non envoyées à la limite d’utilisateurs virtuels ou réponses trop tardives.",
  "The database pool can answer about {v0} orders before the load generator stops listening, {v1} seconds after its sending window closes; this run would sell {v2}. Their answers would arrive too late.":
    "Le pool de connexions à la base de données peut répondre à environ {v0} commandes avant que le générateur cesse d’écouter, {v1} secondes après la fermeture de sa fenêtre d’envoi ; cette simulation en vendrait {v2}. Leurs réponses arriveraient trop tard.",
  "a safety cutoff of {v0}": "une limite de sécurité de {v0}",
  "Near this deployment's capacity: about {v0} to answer, {v1} % of {v2}.":
    "Près de la capacité de ce déploiement : environ {v0} pour répondre, soit {v1} % de {v2}.",
  "About {v0} to answer, longer than the {v1} seconds the load generator waits: late buyers would end in transport failure.":
    "Environ {v0} pour répondre, au-delà des {v1} secondes d’attente du générateur : les derniers acheteurs subiraient un échec de transport.",
  "Beyond this deployment's capacity: about {v0} to answer, more than {v1}. Expect a failed delivery: answers arriving too late, or requests never sent before the cutoff.":
    "Au-delà de la capacité de ce déploiement : environ {v0} pour répondre, ce qui dépasse {v1}. Attendez-vous à un échec de l’acheminement : réponses tardives ou requêtes jamais envoyées avant la limite.",
  "the {v0} seconds the load generator waits for an answer":
    "la limite d’attente de {v0} secondes du générateur",
  "the {v0}-second safety cutoff": "la limite de sécurité de {v0} secondes",
  "Expected to complete: {v0}.": "Devrait aboutir dans ces conditions : {v0}.",
  "With the order queue": "Avec la file de commandes",
  "Without the order queue": "Sans la file de commandes",
  "With Redis": "Avec Redis",
  "Stock and order queue in PostgreSQL": "Stock et file de commandes dans PostgreSQL",
  "Run {v0} of 2 · {v1}": "Simulation {v0} sur 2 · {v1}",
  "about {v0} per second": "environ {v0} par seconde",
  "Review the Buyers settings and keep the traffic within the available limits.":
    "Vérifiez les réglages de la section « Acheteurs » et respectez les limites disponibles.",
  "Review the Stock settings and keep values within the available limits.":
    "Vérifiez les réglages de la section « Stock » et respectez les limites disponibles.",
  "Review the Slow ERP settings and keep values within the available limits.":
    "Vérifiez les réglages de la section « ERP lent » et respectez les limites disponibles.",
  "Review the Advanced protection settings and keep values within supported limits.":
    "Vérifiez la section « Paramètres de protection avancés » et respectez les limites prises en charge.",
  "Review the custom run settings and try again.":
    "Vérifiez les réglages de la simulation personnalisée et réessayez.",
  "Use an available value for {v0}.": "Utilisez une valeur disponible pour {v0}.",
  "Recent simulated-ERP calls include failures or timeouts":
    "Les appels récents à l’ERP simulé incluent des échecs ou des délais dépassés",
  "Recent simulated-ERP calls succeeded": "Les appels récents à l’ERP simulé ont réussi",
  "No recent simulated-ERP activity": "Aucune activité récente de l’ERP simulé",
  "Something didn't work on our side": "Un problème est survenu de notre côté",
  "Try again shortly. If the problem continues, the demo may be temporarily unavailable.":
    "Réessayez dans un instant. Si le problème persiste, la démo peut être temporairement indisponible.",
  "For larger runs, run the project locally or deploy it on larger infrastructure.":
    "Pour des simulations plus importantes, lancez le projet localement ou sur une infrastructure plus puissante.",
  "Checking availability": "Vérification de la disponibilité",
  "Checking the latest information now.": "Vérification des dernières informations.",
  "Check the highlighted fields": "Vérifiez les champs signalés",
  "Correct the values below and try again.": "Corrigez les valeurs ci-dessous et réessayez.",
  "Edit fields": "Modifier les champs",
  Ready: "Prêt",
  "The latest information is available.": "Les dernières informations sont disponibles.",
  "This run exceeds an infrastructure limit":
    "Cette simulation dépasse une limite de l’infrastructure",
  "This limit was deliberately chosen for the infrastructure running this demo. {v0}":
    "Cette limite a été fixée volontairement pour l’infrastructure de cette démo. {v0}",
  "Edit values": "Modifier les valeurs",
  "The demo backend isn't ready yet — try again in a moment":
    "Le serveur de la démo n’est pas encore prêt — réessayez dans un instant",
  "Check again before starting a run.": "Vérifiez à nouveau avant de démarrer une simulation.",
  "We couldn't confirm whether your run started":
    "Impossible de confirmer le démarrage de votre simulation",
  "Check whether a run is already in progress before starting another one.":
    "Vérifiez si une simulation est déjà en cours avant d’en démarrer une autre.",
  "You’ve reached your visitor start allowance": "Vous avez atteint votre quota de démarrages",
  "The shared demo has reached its start limit":
    "La démo partagée a atteint sa limite de démarrages",
  "Public start limit reached for now — try again later":
    "Limite de démarrages publics atteinte — réessayez plus tard",
  "The public run limit has been reached": "La limite de simulations publiques a été atteinte",
  "Please wait before trying again": "Patientez avant de réessayer",
  "Sign in to continue": "Connectez-vous pour continuer",
  "This operator action is protected.": "Cette action opérateur est protégée.",
  "Sign in": "Se connecter",
  "Operator connection needs attention": "Connexion opérateur à vérifier",
  "The protected control connection is not configured.":
    "La connexion aux contrôles protégés n’est pas configurée.",
  "Review deployment": "Vérifier le déploiement",
  "The run did not start": "La simulation n’a pas démarré",
  "The latest information is temporarily unavailable":
    "Les dernières informations sont temporairement indisponibles",
  "The API cannot be reached": "L’API est inaccessible",
  "Check the values and try again": "Vérifiez les valeurs et réessayez",
  "Use the available fields and limits for this operation.":
    "Utilisez les champs et limites disponibles pour cette opération.",
  "Work cleanup and history completed": "Nettoyage des tâches et de l’historique terminé",
  "Remaining dashboard or shared-state cleanup failed. Retry Reset to finish it; the completed reset does not block new runs.":
    "Le reste du nettoyage (tableau de bord ou état partagé) a échoué. Réessayez la réinitialisation pour le terminer ; la réinitialisation déjà faite ne bloque pas les nouvelles simulations.",
  "Retry Reset": "Réessayer la réinitialisation",
  "Work cleanup needs operator review": "Nettoyage des tâches : vérification opérateur requise",
  "Review the cleanup conflict before retrying Reset.":
    "Examinez le conflit de nettoyage avant de réessayer la réinitialisation.",
  "Review operation": "Vérifier l’opération",
  "The demo is being updated": "La démo est en cours de mise à jour",
  "Its load generator and its backend run different versions, so runs are paused until the update completes. Try again later.":
    "Son générateur de charge et son serveur n’ont pas la même version : les simulations sont suspendues jusqu’à la fin de la mise à jour. Réessayez plus tard.",
  "No room at the hosting provider": "Plus de place chez l’hébergeur",
  "Fly.io status": "État de Fly.io",
  "The operator action could not be completed": "L’action opérateur n’a pas abouti",
  "Review the operation and try again, or contact an operator.":
    "Vérifiez l’opération et réessayez, ou contactez un opérateur.",
  "The API is busy": "L’API est occupée",
  "It is already serving as many status reads as it can.":
    "Elle traite déjà le maximum de lectures d’état.",
  "Reading the current run took too long.":
    "La lecture de la simulation en cours a pris trop de temps.",
  "A demo run is already in progress": "Une simulation de démo est déjà en cours",
  "Watch the current run, then try again when it finishes.":
    "Suivez la simulation en cours, puis réessayez quand elle sera terminée.",
  "Watch live": "Voir en direct",
  "Recovery needs attention": "Récupération à vérifier",
  "Repair the prior reset before starting another run.":
    "Réparez la réinitialisation précédente avant de démarrer une autre simulation.",
  "Retry recovery": "Réessayer la récupération",
  "The previous run is still recovering": "La simulation précédente est encore en récupération",
  "Worker work may still settle. New runs remain unavailable until recovery completes.":
    "Le worker peut encore finaliser des tâches. Impossible de lancer une nouvelle simulation avant la fin de la récupération.",
  "That preset slug is already in use": "Cet identifiant de scénario est déjà utilisé",
  "Choose another slug before duplicating the preset.":
    "Choisissez un autre identifiant avant de dupliquer le scénario.",
  "Choose another slug": "Choisir un autre identifiant",
  "This preset can no longer be archived": "Ce scénario ne peut plus être archivé",
  "Refresh the preset list and review the available actions.":
    "Actualisez la liste des scénarios et vérifiez les actions disponibles.",
  "Refresh presets": "Actualiser les scénarios",
  "That saved report could not be found": "Ce rapport enregistré est introuvable",
  "Choose an available report from run history.":
    "Choisissez un rapport disponible dans l’historique.",
  "View run history": "Voir l’historique des simulations",
  "The requested item is no longer available": "L’élément demandé n’est plus disponible",
  "Review the operation and choose an available item.":
    "Vérifiez l’opération et choisissez un élément disponible.",
  "That result is no longer available": "Ce résultat n’est plus disponible",
  "Try another result.": "Essayez un autre résultat.",
  "Try again": "Réessayer",
  "Try again shortly.": "Réessayez dans un instant.",
  "Try again later.": "Réessayez plus tard.",
  "Wait {v0} before trying again.": "Patientez {v0} avant de réessayer.",
  "Try again later": "Réessayer plus tard",
  "Wait before retrying": "Patienter avant de réessayer",
  "Traffic dispatch": "Envoi du trafic",
  "ERP capacity": "Capacité ERP",
  "Concurrent order processing": "Traitement simultané des commandes",
  "ERP response delay": "Délai de réponse ERP",
  "ERP availability": "Disponibilité ERP",
  "No supported estimate": "Aucune estimation possible",
  "ERP availability prevents a supported estimate.":
    "La disponibilité de l’ERP rend toute estimation impossible.",
  "The error rate is too high for a supported estimate.":
    "Le taux d’erreur est trop élevé pour permettre une estimation.",
  "This scenario does not have a supported estimate.":
    "Aucune estimation possible pour ce scénario.",
  "Configuration not allowed.": "Configuration non autorisée.",
  "The declared permanent ERP outage prevents a finite estimate.":
    "La panne permanente déclarée de l’ERP empêche une estimation finie.",
  "Conservative duration: {v0} seconds.": "Estimation prudente : {v0} secondes.",
  "Demo limit: {v0} seconds.": "Limite de la démo : {v0} secondes.",
  "Bottleneck: {v0}.": "Goulot d’étranglement : {v0}.",
  "Lower the error rate and try again.": "Réduisez le taux d’erreur et réessayez.",
  "Choose another scenario or try again when the demo is available.":
    "Choisissez un autre scénario ou réessayez lorsque la démo sera disponible.",
  "How buyers arrive. Everyone at once: a waiting room releases a batch of buyers together. Steady stream: the waiting room lets new buyers through at a constant rate for a set time.":
    "Arrivée des acheteurs. Tous à la fois : une salle d’attente libère un groupe simultanément. Flux continu : elle laisse entrer les nouveaux acheteurs à débit constant pendant une durée définie.",
  "How many simulated buyers the waiting room releases together. Each one tries to reserve one unit. When there are more buyers than stock, the extra ones are turned away as sold out.":
    "Nombre d’acheteurs simulés libérés d’un coup par la salle d’attente. Chacun tente de réserver une unité. S’il y a plus d’acheteurs que de stock, ceux en trop sont refusés pour rupture de stock.",
  "Simulates an impatient shopper who clicks Buy twice. Both clicks carry the same request key, so the API recognizes the repeat and returns the same reservation instead of taking a second unit.":
    "Simule un acheteur impatient qui clique deux fois sur Acheter. Les deux clics portent la même clé de requête : l’API reconnaît la répétition et renvoie la même réservation sans prendre une seconde unité.",
  "How many new checkout attempts the load generator starts every second, for the whole traffic duration. Delivery can fall short of this target if the generator cannot keep up.":
    "Nombre de nouvelles tentatives d’achat démarrées chaque seconde, pendant toute la durée du trafic. Le débit réel peut être inférieur si le générateur ne suit pas.",
  "How long new buyers keep arriving. Order processing continues after traffic stops, so the run usually lasts longer than this.":
    "Durée pendant laquelle de nouveaux acheteurs arrivent. Le traitement continue après la fin du trafic ; la simulation dure donc généralement plus longtemps.",
  "Every checkout request the load generator will send: buyers (×2 with duplicates), or arrival rate × duration. It must stay within the public limit.":
    "Toutes les requêtes d’achat que le générateur enverra : acheteurs (×2 avec doublons) ou débit × durée. Ce total doit respecter la limite publique.",
  "Units for sale when the run starts. Each successful reservation takes one. Set it below the buyer count to see sold-out rejections. Whatever the load, the system must never sell more than this.":
    "Unités en vente au démarrage. Chaque réservation réussie en prend une. Choisissez un stock inférieur au nombre d’acheteurs pour voir les refus pour rupture de stock. Le système ne doit jamais vendre davantage, quelle que soit la charge.",
  "Extra time the simulated ERP takes to answer each confirmation call. Reservations stay fast because stock is secured before the ERP is called. Orders simply wait longer in the backlog.":
    "Temps supplémentaire pris par l’ERP simulé pour confirmer chaque commande. Les réservations restent rapides car le stock est réservé avant l’appel ERP. Les commandes restent simplement plus longtemps en attente.",
  "The most confirmation calls per second the simulated ERP accepts. Calls above that rate are refused and retried later, so a low capacity makes the order backlog grow, then drain slowly.":
    "Nombre maximal de confirmations par seconde accepté par l’ERP simulé. Les appels au-delà de ce débit sont refusés puis réessayés plus tard : une faible capacité fait donc s’accumuler les commandes en attente, qui se résorbent ensuite lentement.",
  "The share of confirmation calls the simulated ERP fails at random with a temporary error. The worker retries them, so this is not the share of orders that end up failed.":
    "Part des appels de confirmation que l’ERP fait échouer aléatoirement avec une erreur temporaire. Le worker les réessaie : ce n’est donc pas la part des commandes finalement en échec.",
  "A time limit on sending the spike, not on the whole run. If some attempts are still unsent when it expires, the load generator stops and the run reports partial delivery. Order processing continues afterwards.":
    "Limite de temps pour envoyer l’afflux, pas pour toute la simulation. Si des tentatives restent à envoyer à l’échéance, le générateur s’arrête et la simulation signale un acheminement partiel. Le traitement des commandes continue ensuite.",
  "How long the load generator waits after the run is accepted before sending the first buyer. Use it to open the live view on an idle system first.":
    "Délai d’attente du générateur entre l’acceptation de la simulation et l’envoi du premier acheteur. Utile pour ouvrir d’abord le suivi en direct sur un système au repos.",
  "Safety limits around the load generator. The defaults suit most runs.":
    "Limites de sécurité du générateur. Les valeurs par défaut conviennent à la plupart des simulations.",
  "The run currently holding the shared demo. Only one run can be active at a time; new starts are blocked until it finishes or is reset.":
    "Simulation qui occupe actuellement la démo partagée. Une seule simulation peut être active à la fois ; les nouveaux démarrages sont bloqués jusqu’à sa fin ou sa réinitialisation.",
  "Health checks of the services a run needs: database, Redis, queue, load generator, simulated ERP. Runs cannot start while a required dependency is not ready.":
    "État des services nécessaires : base de données, Redis, file, générateur, ERP simulé. Une simulation ne peut pas démarrer si une dépendance requise n’est pas prête.",
  "A preset is a saved scenario: traffic, stock, simulated ERP and worker settings. Public presets are the cards visitors see. Admin presets exist only here. You can also start a one-off run with edited values without saving them.":
    "Un scénario enregistre les réglages du trafic, du stock, de l’ERP et du worker. Les scénarios publics sont les cartes visibles des visiteurs. Les scénarios administrateur existent uniquement ici. Vous pouvez aussi lancer une simulation ponctuelle avec des valeurs modifiées sans les enregistrer.",
  "Operator tools. Reset stops all demo work immediately and frees the demo. Cleanup permanently deletes old generated runs from the history.":
    "Outils opérateur. Réinitialiser arrête immédiatement toutes les tâches de la démo et la libère. Nettoyer supprime définitivement de l’historique les anciennes simulations générées.",
  'Rules for anonymous visitors: how many runs they may start, the values pre-filled in "Customize a scenario", and the limits on what they may enter. Runs already accepted keep their own snapshot.':
    "Règles des visiteurs anonymes : nombre de démarrages autorisés, valeurs préremplies du formulaire « Personnaliser un scénario » et limites de saisie. Les simulations déjà acceptées gardent leur propre instantané.",
  "Permanent technical identifier, used by the API and in run history. It cannot be edited; duplicate the preset to get a new one.":
    "Identifiant technique permanent utilisé par l’API et l’historique. Il ne peut pas être modifié ; dupliquez le scénario pour en obtenir un nouveau.",
  "public: shown to every visitor as a preset card and read-only here. admin: visible only in this console, and editable.":
    "public : carte visible de tous les visiteurs et en lecture seule ici. administrateur : visible uniquement dans cette console et modifiable.",
  'Marks a scratch scenario: the admin "Custom" preset or the base of the public "Customize a scenario" form. Scratch scenarios cannot be archived.':
    "Signale un scénario de travail : le scénario administrateur « Personnalisé » ou la base du formulaire public « Personnaliser un scénario ». Ces scénarios ne peuvent pas être archivés.",
  "Display name shown in preset lists and, for public presets, on the visitor card.":
    "Nom affiché dans les listes et, pour un scénario public, sur sa carte.",
  'Short explanation of what this scenario demonstrates and what a viewer should notice. Shown under "Technical details" on public cards.':
    "Courte explication de ce que montre le scénario et de ce qu’il faut y remarquer. Affichée sous « Détails techniques » sur les cartes publiques.",
  "Position in preset lists. Lower numbers come first.":
    "Position dans les listes. Les plus petits nombres passent en premier.",
  "Identifier for the new admin-only copy of the selected preset. The copy takes the saved values, not unsaved edits.":
    "Identifiant de la nouvelle copie réservée à l’administrateur. La copie reprend les valeurs enregistrées, pas les modifications non enregistrées.",
  'Overwrites the admin "Custom" scratch preset with this preset\'s saved values, so you can experiment without touching the original. It does not change the public form.':
    "Remplace le scénario administrateur « Personnalisé » par les valeurs enregistrées de ce scénario pour expérimenter sans toucher à l’original. Ne modifie pas le formulaire public.",
  "Virtual users (VUs) are the load generator's reusable workers; each sends one request at a time. This many are ready before traffic starts. Too few for the rate and attempts are skipped, reported as partial delivery. Leave both VU fields empty to let the deployment allocate them for the rate.":
    "Les utilisateurs virtuels (VU) sont les workers réutilisables du générateur ; chacun envoie une requête à la fois. Ce nombre de VU est prêt avant le début du trafic. S’il n’y en a pas assez pour le débit, des tentatives sont sautées et signalées comme acheminement partiel. Laissez les deux champs VU vides pour que le déploiement les alloue selon le débit.",
  "The most virtual users the load generator may add when responses slow down and every prepared one is busy. At least the preallocated count. Left empty, both are set at start to the arrival rate × the deployment's latency budget, all preallocated, within the hard caps; visitors' runs always get these.":
    "Nombre maximal d’utilisateurs virtuels que le générateur peut ajouter quand les réponses ralentissent et que tous les VU prêts sont occupés. Au moins égal au nombre préalloué. Si les deux champs sont vides, ils sont fixés au démarrage à débit × budget de latence du déploiement, tous préalloués, dans la limite des plafonds ; les simulations des visiteurs utilisent toujours ces valeurs.",
  'Limits how many runs anonymous visitors may start per time window, per visitor and overall. "Budget" counts starts, not money. Off: visitors may start whenever the demo is free; configuration limits still apply.':
    "Limite les démarrages des visiteurs anonymes par période, par visiteur et au total. Le « budget » compte des démarrages, pas de l’argent. Désactivé : les visiteurs démarrent dès que la démo est libre ; les limites de configuration s’appliquent toujours.",
  "Length of each counting period for public starts (3600 = one hour). Windows are fixed, not rolling: counters reset at each boundary.":
    "Durée de chaque période de comptage des démarrages publics (3600 = une heure). Les fenêtres sont fixes, pas glissantes : les compteurs se réinitialisent au début de chaque période.",
  "Most runs one visitor may start per window. Visitors are recognized by an anonymous browser credential, not an account.":
    "Nombre maximal de démarrages d’un visiteur par période. Les visiteurs sont reconnus par un identifiant anonyme du navigateur, sans compte.",
  "Most runs all visitors together may start per window. Protects the shared host from a crowd of visitors.":
    "Nombre maximal de démarrages de tous les visiteurs par période. Protège l’hôte partagé d’un afflux de visiteurs.",
  'The values pre-filled in the public "Customize a scenario" form. Settings visitors cannot edit (worker concurrency) are always taken from here; virtual users are set at start from the arrival rate.':
    "Valeurs préremplies du formulaire public « Personnaliser un scénario ». Les réglages non modifiables par les visiteurs, comme les traitements simultanés du worker, proviennent toujours d’ici ; les utilisateurs virtuels sont calculés au démarrage selon le débit.",
  'The highest (or lowest) values visitors may enter in "Customize a scenario". They constrain choices; they do not set a run\'s values. Each must stay within the deployment hard caps below.':
    "Valeurs maximales (ou minimales) que les visiteurs peuvent saisir dans « Personnaliser un scénario ». Elles bornent les choix sans fixer les valeurs de la simulation. Chacune doit respecter les plafonds du déploiement ci-dessous.",
  'Which traffic patterns visitors may pick ("Everyone at once" / "Steady stream"). At least one must stay allowed.':
    "Modes de trafic proposés aux visiteurs (« Tous à la fois » / « Flux continu »). Au moins un mode doit rester autorisé.",
  "Simulated ERP behaviour frozen into every run started from this preset. Accepted runs retain these values until completion.":
    "Comportement de l’ERP simulé figé dans chaque simulation démarrée à partir de ce scénario. Les simulations acceptées conservent ces valeurs jusqu’à leur fin.",
  "How the background worker pulls orders from the queue. Backpressure means the queue absorbs the surge so the slow ERP only receives what it can handle.":
    "Comment le worker récupère les commandes dans la file. Avec la régulation, la file absorbe l’afflux et l’ERP lent ne reçoit que ce qu’il peut traiter.",
  "The exact configuration the run would receive if started now, with your edits merged onto defaults. On start it becomes the run's frozen snapshot, visible later in run history.":
    "Configuration exacte que recevrait la simulation si elle démarrait maintenant, avec vos modifications appliquées aux valeurs par défaut. Au démarrage, elle devient l’instantané figé de la simulation, visible ensuite dans l’historique.",
  "Absolute ceilings set by the server's environment configuration to protect the host. Not editable here. Every preset and public limit must stay below them.":
    "Plafonds absolus définis par la configuration du serveur pour protéger l’hôte. Non modifiables ici. Scénarios et limites publiques doivent tous rester en dessous.",
  "The admin passphrase provided by the project owner. It unlocks the operator controls.":
    "Phrase secrète administrateur fournie par le propriétaire du projet. Elle déverrouille les contrôles opérateur.",
  'Shown to visitors as "Safety cutoff". {v0}': "Nom côté visiteurs : « Limite de sécurité ». {v0}",
  'Shown to visitors as "Arrival rate". {v0}': "Nom côté visiteurs : « Débit d’arrivée ». {v0}",
  'Shown to visitors as "Traffic duration". {v0}': "Nom côté visiteurs : « Durée du trafic ». {v0}",
  'Shown to visitors as "Delay per order". {v0}':
    "Nom côté visiteurs : « Délai par commande ». {v0}",
  'Shown to visitors as "Capacity". {v0} TPS means transactions (confirmation calls) per second. Over the limit the ERP answers HTTP 429 and the worker backs off.':
    "Nom côté visiteurs : « Capacité ». {v0} TPS désigne les transactions (appels de confirmation) par seconde. Au-delà, l’ERP répond HTTP 429 et le worker ralentit ses appels.",
  'Shown to visitors as "Failure rate". {v0} Injected failures are HTTP 503. Runs declaring more than 30% are refused at start because their duration cannot be estimated.':
    "Nom côté visiteurs : « Taux d’échec ». {v0} Les échecs injectés sont des HTTP 503. Les simulations déclarant plus de 30 % sont refusées au démarrage, car leur durée ne peut pas être estimée.",
  "Makes the simulated ERP refuse every confirmation for this run. A run declared this way is refused at start because its duration cannot be estimated. It is kept for completeness of the snapshot, not as a working scenario.":
    "Force l’ERP simulé à refuser toutes les confirmations de cette simulation. Une simulation ainsi déclarée est refusée au démarrage, car sa durée ne peut pas être estimée. Ce réglage existe pour que l’instantané soit complet, pas comme scénario fonctionnel.",
  "How many orders the worker processes in parallel for this run. Higher values drain the backlog faster but push harder on the ERP, which still enforces its own capacity. Also feeds the admission duration estimate.":
    "Nombre de commandes traitées en parallèle par le worker pour cette simulation. Une valeur élevée résorbe plus vite les commandes en attente mais sollicite davantage l’ERP, qui impose toujours sa propre capacité. Sert aussi à estimer la durée à l’admission.",
  "Upper limit on a visitor run's planned total attempts: buyers (×2 with duplicates), or rate × duration.":
    "Plafond du total de tentatives prévues pour une simulation visiteur : acheteurs (×2 avec doublons) ou débit × durée.",
  'Highest value visitors may enter for "Buyer count".':
    "Valeur maximale du « Nombre d’acheteurs » pour les visiteurs.",
  'Highest value visitors may enter for "Arrival rate".':
    "Valeur maximale du « Débit d’arrivée » pour les visiteurs.",
  'Highest value visitors may enter for "Traffic duration" and for "Safety cutoff".':
    "Valeur maximale de la « Durée du trafic » et de la « Limite de sécurité » pour les visiteurs.",
  'Highest value visitors may enter for "Start delay".':
    "Valeur maximale du « Délai de démarrage » pour les visiteurs.",
  "Applies only to virtual users a request sets explicitly. The public form sets none: they are derived at start from the arrival rate, within the deployment hard caps only, so this does not limit a visitor's arrival rate.":
    "Concerne uniquement les utilisateurs virtuels explicitement définis dans une requête. Le formulaire public n’en définit pas : ils sont calculés au démarrage selon le débit et les plafonds du déploiement. Cette limite ne plafonne donc pas le débit d’un visiteur.",
  'Highest value visitors may enter for "Starting stock".':
    "Valeur maximale du « Stock initial » pour les visiteurs.",
  'Highest value visitors may enter for "Delay per order".':
    "Valeur maximale du « Délai par commande » pour les visiteurs.",
  'Lowest "Capacity" visitors may choose. Stops a visitor from making the ERP so slow that the run cannot finish within the demo time limit.':
    "« Capacité » la plus basse que les visiteurs peuvent choisir. Empêche un visiteur de rendre l’ERP si lent que la simulation ne pourrait pas se terminer dans la limite de durée de la démo.",
  'Highest value visitors may enter for "Capacity".':
    "Valeur maximale de la « Capacité » pour les visiteurs.",
  'Highest "Failure rate" visitors may choose.': "« Taux d’échec » maximal pour les visiteurs.",
  "Contradictory evidence: the final stock and order records disagree, so this result needs investigation.":
    "Données contradictoires : le stock final et les commandes ne concordent pas ; ce résultat doit donc être analysé.",
  "Reconciliation warning: some final evidence populations disagree and need investigation.":
    "Avertissement de rapprochement : certains ensembles de données finales ne concordent pas et sont à analyser.",
  "Evidence incomplete: some final evidence was unavailable, so the result could not be fully verified.":
    "Données incomplètes : certaines données finales sont indisponibles ; le résultat n’a pas pu être entièrement vérifié.",
  "{v0} planned requests were never sent. {v1} Outcomes and latency cover recorded responses only.":
    "{v0} requêtes prévues n’ont jamais été envoyées. {v1} Les résultats et la latence couvrent uniquement les réponses enregistrées.",
  "{v0} answers arrived too late to be recorded; {v1} attempts ended in transport failure.":
    "{v0} réponses sont arrivées trop tard pour être enregistrées ; {v1} tentatives ont échoué au niveau du transport.",
  "All sent requests completed.": "Toutes les requêtes envoyées se sont terminées.",
  "Reply observation incomplete: outcomes and latency cover {v0} of {v1} attempts.":
    "Observation des réponses incomplète : les résultats et la latence couvrent {v0} tentatives sur {v1}.",
  "Delivery failed: the load generator could not deliver the planned traffic.":
    "Échec de l’acheminement : le générateur n’a pas pu envoyer le trafic prévu.",
  "Partial delivery: not all planned checkout attempts completed.":
    "Acheminement partiel : certaines tentatives d’achat prévues ne se sont pas terminées.",
  "accepted responses": "réponses acceptées",
  "Unique reservations secured": "Réservations uniques obtenues",
  "sold-out rejections recorded by Checkout-Surge":
    "refus pour rupture de stock enregistrés par Checkout-Surge",
  "sold-out rejections seen by the load generator":
    "refus pour rupture de stock observés par le générateur",
  "load-generator attempts; connection failures may have no response":
    "tentatives du générateur ; les échecs de connexion peuvent ne produire aucune réponse",
  "starting stock": "stock initial",
  "reservations awaiting durable storage": "réservations en attente de stockage durable",
  "reservations past their deadline, still reserved":
    "réservations expirées mais toujours bloquées",
  "reservation-to-confirmation time": "délai entre réservation et confirmation",
  "simulated emails recorded": "e-mails simulés enregistrés",
  "Durable checkout records": "Enregistrements d’achat durables",
  "Traffic delivery": "Acheminement du trafic",
  "Everyone at once": "Tous à la fois",
  "Steady stream": "Flux continu",
  "Reservations confirm cleanly": "Les réservations sont confirmées sans erreur",
  "Stock depletes without overselling": "Le stock s’épuise sans survente",
  "The order backlog grows, then drains": "Les commandes en attente s’accumulent puis se résorbent",
  "The final evidence remains available": "Les données finales restent disponibles",
  "Duplicate clicks replay one reservation": "Les doubles clics renvoient la même réservation",
  "A slow ERP sets the pace; orders wait in the queue":
    "Un ERP lent fixe le rythme ; les commandes attendent dans la file",
  "Slow ERP responses limit orders in flight":
    "Les réponses lentes de l’ERP limitent les commandes en cours",
  "Without the queue, each winner waits for the ERP to confirm":
    "Sans file, chaque gagnant attend la confirmation de l’ERP",
  "Failed orders and retries": "Commandes en échec et nouvelles tentatives",
  Succeeded: "Réussi",
  "Timed out": "Délai dépassé",
  "Not started": "Non démarré",
  Running: "En cours",
  Finished: "Terminé",
  "All planned attempts completed": "Toutes les tentatives prévues sont terminées",
  "Partial delivery": "Acheminement partiel",
  "Delivery failed": "Échec de l’acheminement",
  "Delivery status unavailable": "État de l’acheminement indisponible",
  Finishing: "Finalisation",
  Completed: "Terminée",
  "Completed with order failures": "Terminée avec des commandes en échec",
  "Completed with unsettled orders": "Terminée avec des commandes non finalisées",
  "Oversell detected": "Survente détectée",
  "Result not fully verified": "Résultat partiellement vérifié",
  "The load generator could not deliver the planned traffic, so this run's evidence is incomplete.":
    "Le générateur n’a pas pu envoyer le trafic prévu ; les données de cette simulation sont donc incomplètes.",
  "Start a new run to try again.": "Démarrez une nouvelle simulation pour réessayer.",
  "The load generator could not be started, so no traffic was sent.":
    "Le générateur n’a pas pu démarrer ; aucun trafic n’a été envoyé.",
  "The hosting provider (Fly.io) had no room for the load generator, so no traffic was sent.":
    "L’hébergeur (Fly.io) n’avait plus de place pour le générateur ; aucun trafic n’a été envoyé.",
  "The run could not prepare its stock, so no traffic was sent.":
    "La simulation n’a pas pu préparer son stock ; aucun trafic n’a été envoyé.",
  "The run was cancelled by an automatic reset. Its experiment data was discarded.":
    "La simulation a été annulée par une réinitialisation automatique. Les données de l’expérience ont été supprimées.",
  "Start a new run when the demo is ready.":
    "Démarrez une nouvelle simulation lorsque la démo sera prête.",
  "The run was stopped by an operator before a complete result was recorded.":
    "La simulation a été arrêtée par un opérateur avant l’enregistrement d’un résultat complet.",
  "Processing normally": "Traitement normal",
  "Still processing — the ERP is limiting the rate": "Traitement en cours — l’ERP limite le débit",
  "ERP unavailable — processing resumes automatically":
    "ERP indisponible — reprise automatique du traitement",
  Available: "Disponible",
  "Needs attention": "À vérifier",
  "{v0}-second window": "fenêtre de {v0} secondes",
  "trailing {v0}-second measurement window": "fenêtre de mesure glissante de {v0} secondes",
  "what the load generator observed": "observations du générateur de charge",
  "Reservation and order outcomes recorded by Checkout-Surge":
    "Résultats des réservations et commandes enregistrés par Checkout-Surge",
  "Simulated ERP calls": "Appels à l’ERP simulé",
  "Calls to the simulated ERP recorded by Checkout-Surge":
    "Appels à l’ERP simulé enregistrés par Checkout-Surge",
  "checking availability": "vérification de la disponibilité",
  "Checking availability.": "Vérification de la disponibilité.",
  "Ready to start a run.": "Prêt à démarrer une simulation.",
  "recovery incomplete": "récupération incomplète",
  "New runs remain unavailable until operator recovery completes.":
    "Impossible de lancer une nouvelle simulation avant la fin de la récupération par l’opérateur.",
  "Preparing checkout traffic.": "Préparation du trafic d’achat.",
  "relocating the load generator": "déplacement du générateur de charge",
  "The load generator is moving to another host (for example, when its host is full), so this start takes a little longer. Please wait.":
    "Le générateur change d’hôte (par exemple quand le sien est plein) : le démarrage prend donc un peu plus de temps. Patientez.",
  "accepting checkout attempts": "réception des tentatives d’achat",
  "Buyers are arriving.": "Les acheteurs arrivent.",
  "processing unique reservations": "traitement des réservations uniques",
  "completed successfully": "terminée avec succès",
  "The run completed without oversell or unsettled orders.":
    "La simulation s’est terminée sans survente ni commande non finalisée.",
  "completed with order failures": "terminée avec des commandes en échec",
  "The run completed with one or more failed orders.":
    "La simulation s’est terminée avec une ou plusieurs commandes en échec.",
  "completed with unsettled orders": "terminée avec des commandes non finalisées",
  "The run finalized before every unique reservation secured settled.":
    "La simulation a été clôturée avant que toutes les réservations uniques obtenues soient finalisées.",
  "completed with oversell": "terminée avec une survente",
  "Reserved units exceeded available stock.": "Les unités réservées dépassent le stock disponible.",
  "The run failed.": "La simulation a échoué.",
  "updates unavailable": "mises à jour indisponibles",
  "Current run updates are unavailable.": "Les mises à jour de la simulation sont indisponibles.",
  "outcome unavailable": "résultat indisponible",
  "Final outcome evidence was unavailable for this run.":
    "Les données du résultat final sont indisponibles pour cette simulation.",
  "reservation evidence unavailable": "données de réservation indisponibles",
  "Durable reservation evidence was unavailable for this run.":
    "Les données durables des réservations sont indisponibles pour cette simulation.",
  "contradictory outcome evidence": "données de résultat contradictoires",
  "One or more authoritative final-result checks are broken.":
    "Une ou plusieurs vérifications de référence du résultat final échouent.",
  "inventory evidence unavailable": "données de stock indisponibles",
  "Final inventory evidence was unavailable for this run.":
    "Les données finales de stock sont indisponibles pour cette simulation.",
  "no data": "aucune donnée",
  "Inventory evidence is not yet available.":
    "Les données de stock ne sont pas encore disponibles.",
  "exact sellout": "stock entièrement écoulé",
  "All available stock was reserved without oversell.":
    "Tout le stock disponible a été réservé sans survente.",
  "stock remaining": "stock restant",
  "The run completed without selling out.": "La simulation s’est terminée sans épuiser le stock.",
  "final inventory recorded": "stock final enregistré",
  "Final inventory evidence was recorded for the failed run.":
    "Les données finales de stock ont été enregistrées pour la simulation en échec.",
  "inventory draining": "stock en cours d’épuisement",
  "Stock is being reserved.": "Le stock est en cours de réservation.",
  "inventory ready": "stock prêt",
  "Inventory is ready.": "Le stock est prêt.",
  "Connecting to live updates.": "Connexion aux mises à jour en direct.",
  "live updates": "mises à jour en direct",
  "Live updates are arriving.": "Les mises à jour en direct arrivent.",
  "Connected; no projection update is expected.":
    "Connecté ; aucune mise à jour de la projection n’est attendue.",
  "updates stale": "mises à jour obsolètes",
  "Projection updates are stale.": "La projection n’est plus à jour.",
  "updates disconnected": "mises à jour déconnectées",
  "Live updates are disconnected.": "Les mises à jour en direct sont déconnectées.",
  "live updates unsupported": "mises à jour en direct non prises en charge",
  "Live updates are unsupported.": "Les mises à jour en direct ne sont pas prises en charge.",
  "no active run": "aucune simulation active",
  "Live freshness does not apply.": "Fraîcheur des données en direct : sans objet.",
  "confirmation evidence unavailable": "données de confirmation indisponibles",
  "Final confirmation evidence was unavailable for this run.":
    "Les données finales de confirmation sont indisponibles pour cette simulation.",
  "Confirmation evidence is not yet available.":
    "Les données de confirmation ne sont pas encore disponibles.",
  "awaiting outcomes": "en attente des résultats",
  "No terminal confirmation result exists yet.":
    "Aucun résultat final de confirmation pour l’instant.",
  "no confirmations": "aucune confirmation",
  "No confirmed orders were observed.": "Aucune commande confirmée n’a été observée.",
  "checkout evidence unavailable": "données d’achat indisponibles",
  "Final checkout outcome evidence was unavailable for this run.":
    "Les données finales des résultats d’achat sont indisponibles pour cette simulation.",
  "Outcome evidence is not yet available.":
    "Les données de résultats ne sont pas encore disponibles.",
  "outcomes observed": "résultats observés",
  "Durable outcomes are available.": "Les résultats durables sont disponibles.",
  "ERP evidence unavailable": "données ERP indisponibles",
  "Final simulated ERP evidence was unavailable for this run.":
    "Les données finales de l’ERP simulé sont indisponibles pour cette simulation.",
  "not yet observed": "pas encore observé",
  "ERP outcome evidence for this run is not yet available.":
    "Les résultats ERP de cette simulation ne sont pas encore disponibles.",
  "no ERP calls recorded": "aucun appel ERP enregistré",
  "No simulated ERP calls were recorded for this run.":
    "Aucun appel à l’ERP simulé n’a été enregistré pour cette simulation.",
  "no ERP calls yet": "aucun appel ERP pour l’instant",
  "No simulated ERP calls have been recorded for this run yet.":
    "Aucun appel à l’ERP simulé n’a encore été enregistré pour cette simulation.",
  "failures observed": "échecs observés",
  "This run has recorded ERP failures or timeouts.":
    "Des échecs ou délais dépassés de l’ERP ont été enregistrés pour cette simulation.",
  "ERP attempt outcomes for this run are available.":
    "Les résultats des tentatives ERP de cette simulation sont disponibles.",
  "No units were oversold.": "Aucune unité survendue.",
  "{v0} {v1} pending.": "{v0} en attente.",
  "The run failed; its cause was not recorded.":
    "La simulation a échoué ; sa cause n’a pas été enregistrée.",
  "{v0} {v1} failed.": "{v0} {v1} en échec.",
  "The completed run has contradictory authoritative evidence: one or more invariants are broken.":
    "La simulation terminée présente des données de référence contradictoires : un ou plusieurs invariants sont rompus.",
  "The run outcome is indeterminate because authoritative evidence is incomplete.":
    "Le résultat est indéterminé car les données de référence sont incomplètes.",
  "Stock evidence is unavailable.": "Les données de stock sont indisponibles.",
  "Durable records show {v0} reserved against {v1}, so {v2} {v3} oversold.":
    "Les enregistrements durables indiquent une réservation de {v0} pour {v1}, soit une survente de {v2}.",
  "starting unit": "unité initiale",
  "The sale started with no stock available to reserve.":
    "La vente a commencé sans stock disponible à réserver.",
  "The only available unit was reserved without overselling.":
    "L’unique unité disponible a été réservée sans survente.",
  "All {v0} available units were reserved without overselling.":
    "Les {v0} unités disponibles ont été réservées sans survente.",
  "{v0} {v1} reserved from {v2}, and {v3} {v4}.":
    "Réservations : {v0} sur {v2} ; stock restant : {v3}.",
  "Checkout-Surge recorded {v0}.": "Checkout-Surge a enregistré {v0}.",
  "sold-out rejection": "refus pour rupture de stock",
  "Order evidence is unavailable.": "Les données de commandes sont indisponibles.",
  "{v0} {v1} confirmed, {v2} failed, and {v3} {v4} pending.":
    "Confirmées : {v0} ; échecs : {v2} ; en attente : {v3}.",
  "The order for the only reservation was confirmed, with no failed orders.":
    "La commande de l’unique réservation a été confirmée, sans commande en échec.",
  "The orders for all {v0} reservations were confirmed, with no failed orders.":
    "Les commandes des {v0} réservations ont été confirmées, sans commande en échec.",
  "{v0} {v1} confirmed, with no failed orders.": "Confirmées : {v0}, sans commande en échec.",
  "Order outcomes: {v0} confirmed, {v1} failed, and {v2} pending.":
    "Résultats des commandes : {v0} confirmées, {v1} en échec et {v2} en attente.",
  "an unreported number of": "un nombre non indiqué de",
  "not evaluable": "non évaluable",
  "Not yet available": "Pas encore disponible",
  "Convergence incomplete · {v0} pending": "Convergence incomplète · {v0} en attente",
  "Convergence duration unavailable": "Durée de convergence indisponible",
  "Converged in {v0}": "Convergence en {v0}",
  "Final convergence evidence unavailable": "Données finales de convergence indisponibles",
  "{v0}/{v1} confirmed · {v2} pending": "{v0}/{v1} confirmées · {v2} en attente",
  "Peak {v0}": "Pic {v0}",
  "{v0} of {v1} left · {v2}": "{v0} restantes sur {v1} · {v2}",
  "oversell unknown": "survente inconnue",
  "{v0} oversold": "{v0} survendues",
  "Peak {v0} · {v1}": "Pic {v0} · {v1}",
  "drain duration unavailable": "durée de résorption indisponible",
  "drained in {v0}": "résorption en {v0}",
  "{v0} waiting · peak {v1}": "{v0} en attente · pic {v1}",
  "Dispatched in {v0}": "Envoi en {v0}",
  "not depleted": "non épuisé",
  "depleted in {v0}": "épuisé en {v0}",
  " · 95% of confirmed orders within {v0}": " · 95 % des commandes confirmées en moins de {v0}",
  "{v0} failed · lag avg {v1}, max {v2}": "{v0} en échec · délai moyen {v1}, max. {v2}",
  "Traffic evidence unavailable: no usable completion report was recorded. Traffic counters, HTTP outcomes and latency are unknown.":
    "Données de trafic indisponibles : aucun rapport final exploitable n’a été enregistré. Compteurs de trafic, résultats HTTP et latence inconnus.",
  "Its experiment data was discarded.": "Les données de l’expérience ont été supprimées.",
  request: "requête",
  requests: "requêtes",
  answer: "réponse",
  answers: "réponses",
  notification: "notification",
  notifications: "notifications",
  "virtual users": "utilisateurs virtuels",
  "completed attempts": "tentatives terminées",
  "starting units": "unités initiales",
  "sold-out rejections": "refus pour rupture de stock",
  those: "celles",
  it: "elle",
  them: "elles",
  holds: "respecté",
  broken: "rompu",
  unavailable: "indisponible",
  starting: "en cours de démarrage",
  failed: "en échec",
  connecting: "connexion",
  available: "disponible",
  "Unique reservations secured are waiting to be confirmed or failed.":
    "Les réservations uniques obtenues attendent leur confirmation ou leur échec final.",
  " or ": " ou ",
  ", or ": ", ou ",
  " No units were oversold.": " Aucune unité survendue.",
  "attempts/s": "tentatives/s",
  "responses/s": "réponses/s",
  "reservations/s": "réservations/s",
  "confirmations/s": "confirmations/s",
  live: "en direct",
  connected: "connecté",
  disconnected: "déconnecté",
  unsupported: "non pris en charge",
  "failed,": "en échec,",
  "pending;": "en attente ;",
  "{requests} waited {seconds} seconds without an answer, so the run counts as failed.":
    "Aucune réponse après {seconds} secondes pour {requests} : la simulation est donc en échec.",
  "{buyers} waited at least {seconds} seconds without an answer, so the run counts as failed.":
    "Aucune réponse après au moins {seconds} secondes pour {buyers} : la simulation est donc en échec.",
  "{label}: no samples retained.": "{label} : aucun échantillon conservé.",
  "{label}: {sample}.": "{label} : {sample}.",
  truncated: "tronquées",
  "{value} {unit} at {time}": "{value} {unit} à {time}",
  "{label}: starts at {first}, peaks at {peak}, ends at {last}.":
    "{label} : début à {first}, pic à {peak}, fin à {last}.",
  "Disable the declared permanent ERP outage to obtain a finite estimate.":
    "Désactivez la panne permanente déclarée de l’ERP pour obtenir une estimation finie.",
  "Increase declared ERP capacity or reduce acceptable orders/stock.":
    "Augmentez la capacité déclarée de l’ERP, ou réduisez les commandes acceptables ou le stock.",
  "Lower the declared error rate to 30% or less to obtain a supported estimate.":
    "Réduisez le taux d’erreur déclaré à 30 % ou moins pour permettre une estimation.",
  "Shorten the traffic duration or start delay.":
    "Réduisez la durée du trafic ou le délai de démarrage.",
  "Lower declared ERP latency or reduce acceptable orders/stock.":
    "Réduisez la latence déclarée de l’ERP, les commandes acceptables ou le stock.",
  "Increase per-run concurrency up to 10, lower ERP latency, or reduce acceptable orders/stock.":
    "Augmentez les traitements simultanés de la simulation jusqu’à 10, ou réduisez la latence de l’ERP, les commandes acceptables ou le stock.",
  "The only accepted order was confirmed and notified":
    "L’unique commande acceptée a été confirmée et notifiée",
  "All {v0} accepted orders were confirmed and notified":
    "Les {v0} commandes acceptées ont été confirmées et notifiées",
  "{v0} answer arrived too late to be recorded":
    "{v0} réponse est arrivée trop tard pour être enregistrée",
  "{v0} answers arrived too late to be recorded":
    "{v0} réponses sont arrivées trop tard pour être enregistrées",
  "order confirmed,": "commande confirmée,",
  "orders confirmed,": "commandes confirmées,",
  "notification recorded.": "notification enregistrée.",
  "notifications recorded.": "notifications enregistrées.",
  queued: "en file",
  "; ": " ; ",
  "{v0} of {v1} {v2} arrived too late ({v3}%).":
    "Réponses arrivées trop tard : {v0} sur {v1} ({v3} %).",
  "{v0} of {v1} {v2} completed ({v3}% shortfall).":
    "Requêtes terminées : {v0} sur {v1} ({v3} % manquantes).",
  "{v0} of {v1} {v2} timed out ({v3}%).": "Requêtes expirées : {v0} sur {v1} ({v3} %).",
  "{title} diagnostics were unavailable.": "{title} : diagnostics indisponibles.",
  "reserved units = starting stock − remaining stock":
    "unités réservées = stock initial − stock restant",
  "confirmed + failed + pending = unique reservations":
    "confirmées + en échec + en attente = réservations uniques",
  "oversold units = 0": "unités survendues = 0",
};
