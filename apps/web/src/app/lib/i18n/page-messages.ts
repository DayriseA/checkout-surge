export const pageMessages: Record<string, string> = {
  "Checkout-Surge is a live demo of the system behind a flash sale.":
    "Checkout-Surge est une démo live du système derrière une vente flash.",
  "Checkout-Surge: a live demo of the system behind a flash sale":
    "Checkout-Surge : démo live du système derrière une vente flash",
  "Nobody gets a unit that does not exist, and the back office is never flooded. Start a simulated sale and watch it live.":
    "Personne n’achète une unité qui n’existe pas, et le back-office n’est jamais submergé. Lancez une vente simulée et suivez-la en direct.",
  "What goes wrong, and the standard answer": "Ce qui coince, et la solution standard",
  "Three things go wrong when demand far exceeds stock. Each has an answer that is":
    "Lorsque la demande dépasse largement le stock, trois problèmes se posent. Chacun a une solution",
  "standard in the industry": "courante dans le secteur",
  ", and the demo runs all three.": ", et la démo applique les trois.",
  "In front of all this, a": "En amont, une",
  "waiting room": "salle d’attente",
  " lets buyers in at a pace the checkout can absorb. The demo is the checkout behind it.":
    " laisse entrer les acheteurs au rythme que le système d’achat peut absorber. La démo, c’est le système d’achat derrière elle.",
  "The demo's checkout, in one picture": "Le parcours d’achat de la démo, en une image",
  "The markers are the three answers above.":
    "Les repères correspondent aux trois solutions ci-dessus.",
  "The software is real; the buyers, the back office and the emails are":
    "Le code est réel ; les acheteurs, le back-office et les e-mails sont",
  simulated: "simulés",
  "What each choice buys, measured": "Ce que chaque choix apporte, chiffres à l’appui",
  "Same workload, run twice, with one choice switched.":
    "Même charge, lancée deux fois, avec un seul choix modifié.",
  "Same {value0} orders confirmed, at the same back-office pace: the queue moves the wait from the buyer to the back office.":
    "Les mêmes {value0} commandes confirmées, au même rythme : la file de commandes déplace l’attente de l’acheteur vers le back-office.",
  "With and without the order queue": "Avec et sans file de commandes",
  "Same {value0} units sold, and the same answers. With the stock in PostgreSQL, the database also does the turned-away crowd's work. Winners are not faster: at this scale, the database is not the bottleneck.":
    "Les mêmes {value0} unités vendues et les mêmes réponses. Avec le stock dans PostgreSQL, la base traite aussi les acheteurs refusés. Les gagnants ne sont pas plus rapides : à cette échelle, la base n’est pas le goulot d’étranglement.",
  "With and without Redis": "Avec et sans Redis",
  "A demo, at demo scale": "Une démo, à son échelle",
  "The whole system runs on one machine, for up to ":
    "Tout le système tourne sur une seule machine, pour un maximum de ",
  " buyers arriving in about a second.": " acheteurs qui arrivent en une seconde environ.",
  "No payment step and no bot protection.": "Ni étape de paiement, ni protection anti-bots.",
  "Its databases sit on the same machine as its code, not across a network.":
    "Les bases de données tournent sur la même machine que le code, pas à distance.",
  "For engineers": "Pour les développeurs",
  "Node.js, Fastify, Redis, PostgreSQL, BullMQ, k6, Next.js, on Fly.io. The demo sleeps when nobody uses it and wakes in about ":
    "Node.js, Fastify, Redis, PostgreSQL, BullMQ, k6 et Next.js sur Fly.io. La démo se met en veille quand personne ne l’utilise et se réveille en environ ",
  " seconds.": " secondes.",
  "Under the hood →": "Sous le capot →",
  "Repository ↗": "Code source ↗",
  "See it under load": "Voir le système sous charge",
  "Choose a simulation, start it, and watch the system handle a release of buyers.":
    "Choisissez une simulation, lancez-la et regardez le système encaisser une vague d’acheteurs.",
  "Run it": "Lancer",
  "How to read it →": "Comment lire les résultats →",
  "buyers press “Buy” within about a second": "acheteurs cliquent sur « Acheter » en une seconde",
  "units, and one checkout decides": "unités, et un seul système d’achat décide",
  "orders a second, the back office's pace": "commandes par seconde, le rythme du back-office",
  "Try the demo": "Essayer la démo",
  "What shops do when demand far exceeds stock, why it is standard, and what this demo shows of it.":
    "Ce que font les boutiques quand la demande dépasse de loin le stock, pourquoi c’est la norme, et ce que la démo en montre.",
  "How flash-sale checkouts are built": "Comment on conçoit le système d’achat d’une vente flash",
  "A flash sale in three numbers": "Une vente flash en trois chiffres",
  "A flash sale puts many buyers in front of little stock, all at once. Take this demo's largest preset:":
    "Une vente flash, c’est beaucoup d’acheteurs face à peu de stock, tous au même moment. Prenons le plus gros scénario de la démo :",
  "So the system must answer everyone fast, sell each unit only once, and protect both the back office and the rest of the shop. A real purchase goes through five steps, and the demo covers some of them:":
    "Le système doit donc répondre vite à tous, ne vendre chaque unité qu’une fois, et protéger le back-office comme le reste de la boutique. Un vrai achat passe par cinq étapes, et la démo en couvre une partie :",
  "Four practices are standard for this. Each one solves a problem, and each one has a cost.":
    "Quatre pratiques sont la norme. Chacune résout un problème, et chacune a un coût.",
  "The checkout sees a load it was sized for, and visitors see a place in line instead of errors.":
    "Le système d’achat reçoit une charge adaptée à sa capacité, et les visiteurs voient leur place dans la file plutôt que des erreurs.",
  "Buyers wait before they can even try. And each release still arrives as a burst, so the checkout behind the waiting room must still take a spike.":
    "Les acheteurs attendent avant même de pouvoir tenter leur chance. Et chaque groupe libéré arrive en rafale : le système d’achat derrière la salle d’attente doit quand même encaisser un pic.",
  "The demo is the checkout behind the waiting room. “Everyone at once” plays one release, and “Steady stream” plays its steady outflow. See":
    "La démo, c’est le système d’achat derrière la salle d’attente. « Tous à la fois » rejoue la libération d’un groupe, et « Flux continu » le débit régulier de la salle. Voir",
  "what is simulated": "ce qui est simulé",
  "Tens of thousands of people press “Buy” in the same second. No checkout answers that many at once, and a crowd that times out keeps retrying.":
    "Des dizaines de milliers de personnes cliquent sur « Acheter » dans la même seconde. Aucun système d’achat ne peut répondre à autant de monde d’un coup, et une foule dont les requêtes expirent réessaie sans arrêt.",
  "A virtual waiting room in front of the shop. It holds visitors in line and lets them through in batches, or as a steady stream, at a rate the checkout can absorb.":
    "Une salle d’attente virtuelle devant la boutique. Elle place les visiteurs dans une file et les laisse passer par groupes, ou en flux régulier, au rythme que le système d’achat peut absorber.",
  "1. Let buyers in at a pace you can absorb":
    "1. Faire entrer les acheteurs à un rythme soutenable",
  "No unit is ever sold twice, and the turned-away buyers never touch the database: it only does the orders' work.":
    "Aucune unité n’est vendue deux fois, et les acheteurs refusés ne sollicitent jamais la base : elle ne traite que les commandes.",
  "Redis keeps turned-away buyers off the database, but each winner costs more work, since two stores must be kept in step, with a recovery for when the second write fails. Redis has its own ceiling, and winners are not faster.":
    "Redis évite à la base de traiter les acheteurs refusés, mais chaque gagnant demande davantage de travail : deux systèmes de stockage doivent rester cohérents, avec une reprise si la seconde écriture échoue. Redis a aussi sa limite, et les gagnants ne sont pas plus rapides.",
  "Every run decides the stock in Redis. The":
    "Dans chaque simulation, Redis décide du stock. Le scénario",
  " runs the same sale with the stock in PostgreSQL instead. One limit:":
    " rejoue la même vente avec le stock dans PostgreSQL. Une limite :",
  "winners are not faster": "les gagnants ne sont pas plus rapides",
  "Thousands of buyers ask for the last units at the same moment. If two of them can see the same unit as free, it is sold twice. And if every one of them queries the main database, the turned-away crowd keeps it busy just to hear “sold out”.":
    "Des milliers d’acheteurs réclament les dernières unités au même instant. Si deux d’entre eux voient la même unité libre, elle est vendue deux fois. Et si chacun interroge la base principale, les acheteurs refusés l’occupent juste pour s’entendre dire « épuisé ».",
  "Keep the stock count in an in-memory store (Redis) and decide each request there in one atomic step: check and take a unit together, so no two buyers can take the same one. Only the buyers who get a unit go on to the database, where their order is saved.":
    "Garder le compteur de stock en mémoire (Redis) et y décider de chaque requête en une seule opération atomique : vérifier et prendre l’unité d’un coup, pour que deux acheteurs ne prennent jamais la même. Seuls ceux qui obtiennent une unité vont ensuite jusqu’à la base, qui enregistre leur commande.",
  "2. Decide the stock in memory, in one step":
    "2. Décider du stock en mémoire, en une seule opération",
  "The main database (PostgreSQL) is the system of record. It has one primary that accepts writes and a limited number of connections, and the rest of the shop depends on it. Redis decides in memory, atomically and without row locks, scales out cheaply, and holds data that can be rebuilt. The point is not to move the load elsewhere: it is to keep the database free for the orders, and to keep the surge away from the rest of the shop.":
    "La base principale (PostgreSQL) est la source de vérité. Elle a un seul primaire qui accepte les écritures, un nombre limité de connexions, et le reste de la boutique en dépend. Redis décide en mémoire, de façon atomique et sans verrou de ligne, passe à l’échelle à moindre coût et contient des données qu’on peut reconstruire. Le but n’est pas de déplacer la charge : c’est de garder la base libre pour les commandes, et le pic loin du reste de la boutique.",
  "Buyers get their answer in seconds, whatever the back office does. The back office is never flooded. Queued orders survive a crash and are retried safely.":
    "Les acheteurs ont leur réponse en quelques secondes, quoi que fasse le back-office, qui n’est jamais submergé. Les commandes en attente survivent à une panne et sont relancées sans risque.",
  "“Secured” comes before “confirmed”, so a failure after the “yes” must be handled. There are more moving parts to run and watch. And the back office is not faster: the queue moves the wait, it does not remove it.":
    "« Réservé » vient avant « confirmé » : il faut donc gérer une panne après le « oui ». Il y a plus de composants à faire tourner et à surveiller. Et le back-office n’est pas plus rapide : la file déplace l’attente, sans la supprimer.",
  "Every run's backlog chart shows the queue fill and drain. Slow ERP and Laggy ERP slow the back office down. The":
    "Dans chaque simulation, le graphique des commandes en attente montre la file se remplir puis se vider. « ERP lent » et « ERP à forte latence » ralentissent le back-office. La",
  "queue comparison": "comparaison de la file de commandes",
  " runs the same sale with each winner waiting for the back office.":
    " rejoue la même vente en faisant attendre chaque gagnant jusqu’à la confirmation.",
  "Here the worker follows the back office's declared limit, as is common with ERP and SaaS services that publish theirs. When a limit is unknown or changes, an adaptive limiter on the caller's side is the usual technique.":
    "Ici, le worker respecte la limite déclarée par le back-office, comme c’est courant avec les services ERP et SaaS qui publient les leurs. Lorsqu’une limite est inconnue ou variable, on utilise habituellement un limiteur adaptatif côté appelant.",
  "The back office (an ERP, payment capture, a warehouse) handles a few dozen orders per second; a sale produces hundreds in a second. If each buyer's request waits for the back office, buyers wait in line behind it, and a back office pushed past its limit slows down or fails.":
    "Le back-office (ERP, encaissement, entrepôt) traite quelques dizaines de commandes par seconde ; une vente en produit des centaines en une seconde. Si la requête de chaque acheteur attend le back-office, les acheteurs font la queue derrière lui, et, poussé au-delà de sa limite, il ralentit ou tombe en panne.",
  "Save the order, answer the buyer at once, and put the order in a queue (BullMQ). A worker takes orders from the queue at the pace the back office can handle, and has each one confirmed.":
    "Enregistrer la commande, répondre tout de suite à l’acheteur et mettre la commande dans une file (BullMQ). Un worker prend les commandes dans la file au rythme que le back-office peut suivre, et fait confirmer chacune d’elles.",
  "3. Say “yes” now, confirm later": "3. Dire « oui » tout de suite, confirmer ensuite",
  "A double click, a timeout or a retry never buys twice, so every part of the system can retry freely.":
    "Un double clic, une expiration ou une nouvelle tentative n’achète jamais deux fois : chaque composant peut donc réessayer librement.",
  "Keys to store and look up, and a back office that supports them: if it cannot say whether it already took an order, no retry is safe.":
    "Des clés à stocker et à retrouver, et un back-office qui les prend en charge : s’il ne sait pas dire s’il a déjà pris une commande, aucune nouvelle tentative n’est sûre.",
  "The Duplicate-click storm preset clicks “Buy” twice for every buyer. The simulated ERP keeps a ledger of confirmations, so the worker checks an uncertain call before replaying it. See the":
    "Le scénario « Avalanche de doubles clics » clique deux fois sur « Acheter » pour chaque acheteur. L’ERP simulé conserve un registre des confirmations : le worker vérifie donc tout appel incertain avant de le rejouer. Voir les",
  "safety nets": "filets de sécurité",
  "Buyers double-click, phones lose their connection, and systems retry after a timeout. Without care, a retry buys twice, or confirms an order twice.":
    "Les acheteurs double-cliquent, les téléphones perdent leur connexion et les systèmes réessaient après une expiration. Sans précaution, une nouvelle tentative achète deux fois, ou confirme deux fois une commande.",
  "Give each request a key (an idempotency key). A request that comes back with a key already seen gets the first answer again instead of acting again. And when a call's result is uncertain, check it before any replay.":
    "Donner à chaque requête une clé d’idempotence. Une requête qui revient avec une clé déjà connue reçoit la réponse initiale sans agir une seconde fois. Si le résultat d’un appel est incertain, le vérifier avant tout rejeu.",
  "4. Make every step safe to repeat": "4. Rendre chaque étape rejouable sans risque",
  "What the demo shows, at its scale": "Ce que montre la démo, à son échelle",
  "Real sales can be far larger. The patterns carry over; the numbers do not. See":
    "Les vraies ventes peuvent être bien plus grosses. Les principes se transposent ; les chiffres, non. Voir",
  "the demo's scale": "l’échelle de la démo",
  "The queue comparison": "La comparaison de la file de commandes",
  "The queue moves the wait from the buyer to the back office; it does not make the back office faster.":
    "La file déplace l’attente de l’acheteur vers le back-office, sans rendre celui-ci plus rapide.",
  "Surge 5k (5,000 buyers released at once for 500 units, with a back office that confirms 20 orders per second, simulated), twice in a row. Run 1 is the demo as built. In run 2, each winner's request stays open until the same worker has the order confirmed by the back office. After 45 seconds, a winner would be told “secured, not yet confirmed” and the order would still be confirmed later: nothing is lost by design. All {value0} orders were confirmed in every measured run.":
    "Afflux 5k (5 000 acheteurs libérés d’un coup pour 500 unités, avec un back-office simulé qui confirme 20 commandes par seconde), deux fois de suite. La simulation 1 est la démo normale. Dans la simulation 2, la requête de chaque gagnant reste ouverte jusqu’à ce que le même worker ait fait confirmer la commande par le back-office. Au bout de 45 secondes, le gagnant recevrait « réservé, pas encore confirmé » et la commande serait quand même confirmée plus tard : par construction, rien n’est perdu. Les {value0} commandes ont été confirmées dans chaque simulation mesurée.",
  "Same buyers, stock, back-office limit, worker and protections in both runs. The order is fixed: the run with the queue always goes first.":
    "Mêmes acheteurs, même stock, même limite du back-office, même worker et mêmes protections dans les deux simulations. L’ordre est fixe : la simulation avec la file passe toujours en premier.",
  "The Redis comparison": "La comparaison Redis",
  "The headline is the database's load. With the stock in PostgreSQL, it runs {value0} the transactions and spends {value1} as long in queries, for the same 500 units sold. Turned-away buyers are answered a little sooner with Redis, and winners wait about the same. The speed gap stays small because the database is not the bottleneck at this scale. It would be with several API instances sharing it, with a remote database behind a small connection pool, or with a database busy with the rest of the shop.":
    "Le résultat principal est la charge de la base. Avec le stock dans PostgreSQL, elle effectue {value0} plus de transactions et passe {value1} plus de temps en requêtes, pour les mêmes 500 unités vendues. Redis répond un peu plus tôt aux acheteurs refusés ; les gagnants attendent à peu près autant. L’écart de vitesse reste faible car la base n’est pas le goulot d’étranglement à cette échelle. Elle le serait avec plusieurs instances d’API, une base distante derrière un petit pool de connexions, ou une base occupée par le reste de la boutique.",
  "Surge 10k (10,000 buyers released at once for 500 units), twice in a row. Run 1 is the demo as built. Run 2 moves both of Redis's jobs, the stock decision and the order queue, into PostgreSQL, with the same protections. Redis still carries the live counters and the notifications in both runs, and the same two buy-only API processes serve both.":
    "Afflux 10k (10 000 acheteurs libérés d’un coup pour 500 unités), deux fois de suite. La simulation 1 est la démo normale. La simulation 2 transfère les deux rôles de Redis, la décision de stock et la file de commandes, dans PostgreSQL, avec les mêmes protections. Dans les deux simulations, Redis garde les compteurs en direct et les notifications, et les deux mêmes processus d’API réservés aux achats servent l’une et l’autre.",
  "A standard PostgreSQL design, not a strawman: one stock row, a conditional decrement, a read-only check first, and no write for a sold-out answer. The same connection pools and protections in both runs, and a window that leaves out up to its last second of the database's work, which understates the gap. The order is fixed: the Redis run always goes first. PostgreSQL and Redis run on the API's machine. In a real deployment they would sit about a millisecond away, which would add about the same to every answer in both runs without changing what the comparison shows.":
    "Une conception PostgreSQL courante, et non une caricature : une ligne de stock, un décrément conditionnel, une vérification préalable en lecture seule et aucune écriture pour une réponse « épuisé ». Les mêmes pools de connexions et protections dans les deux simulations. La fenêtre omet au plus sa dernière seconde de travail de la base, ce qui réduit l’écart observé. L’ordre est fixe : la simulation Redis passe toujours en premier. PostgreSQL et Redis tournent sur la machine de l’API. Dans un déploiement réel, ils seraient à environ une milliseconde sur le réseau, ce qui ajouterait à peu près la même latence à chaque réponse des deux simulations sans changer ce que montre la comparaison.",
  "In this demo ": "Dans cette démo ",
  "{value0} Your run will differ a little.":
    "{value0} Votre simulation sera légèrement différente.",
  "How to read each figure": "Comment lire chaque mesure",
  "A fair test": "Une comparaison équitable",
  "What is simulated, what the demo's scale means, what the comparisons cannot show, what a real system would add, and the defects we know of.":
    "Ce qui est simulé, ce que veut dire l’échelle de la démo, ce que les comparaisons ne peuvent pas montrer, ce qu’un vrai système ajouterait, et les défauts connus.",
  "Limits and known defects": "Limites et défauts connus",
  "What is real and what is simulated": "Ce qui est réel et ce qui est simulé",
  "Real demo components": "Composants réels de la démo",
  "A real API, Redis, PostgreSQL, BullMQ queue, and worker runtime execute the reservation, durable-record, and background-processing paths.":
    "Une véritable API, Redis, PostgreSQL, une file BullMQ et un worker exécutent la réservation, l’enregistrement durable et le traitement en arrière-plan.",
  "Simulated business activity": "Activité métier simulée",
  "The buyers are simulated by the load generator (k6). Legacy-ERP delay, capacity, failures, and outages are simulated, and post-confirmation notifications are":
    "Les acheteurs sont simulés par le générateur de charge k6. Les délais, la capacité, les erreurs et les indisponibilités de l’ERP sont simulés, et les notifications après confirmation sont des",
  ". There is no production external ERP or notification integration. The waiting room is not modelled: the load generator plays the traffic it lets through.":
    ". Aucun ERP externe ni service de notification de production n’est intégré. La salle d’attente n’est pas modélisée : le générateur de charge simule les acheteurs qu’elle laisse passer.",
  "There is no payment step: a buyer who secures a unit gets an order at once, recorded before the answer.":
    "Aucune étape de paiement : un acheteur qui réserve une unité obtient immédiatement une commande, enregistrée avant la réponse.",
  "The two other modes, without the order queue and with the stock and the order queue in PostgreSQL, exist only in the two comparison presets. Every other run uses the demo as built.":
    "Les deux autres modes, sans file de commandes et avec le stock et la file de commandes dans PostgreSQL, n’existent que dans les deux scénarios de comparaison. Toutes les autres simulations utilisent la démo normale.",
  Scale: "Échelle",
  "One core Machine runs everything except the load generator: the API, the worker, the simulated ERP, PostgreSQL and Redis share its CPUs.":
    "Une machine principale fait tourner tout sauf le générateur de charge : l’API, le worker, l’ERP simulé, PostgreSQL et Redis se partagent ses CPU.",
  "One API process answers every buyer of an ordinary run and of the queue comparison. Two buy-only processes serve the Redis comparison's runs, because a single process was the bottleneck in both of its modes.":
    "Un processus d’API répond à tous les acheteurs des simulations ordinaires et de la comparaison de la file de commandes. Deux processus réservés aux achats servent la comparaison Redis, car un seul processus limitait les deux modes.",
  "The largest preset releases 10,000 buyers in about a second. Real sales can be far larger: the patterns carry over, the numbers do not.":
    "Le plus gros scénario libère 10 000 acheteurs en une seconde environ. Les vraies ventes peuvent être bien plus grosses : les principes se transposent, les chiffres non.",
  "The demo refuses a visitor's run that is too heavy for it, rather than letting it fail (see ":
    "La démo refuse la simulation d’un visiteur trop lourde pour elle, plutôt que de la laisser échouer (voir ",
  "what limits a run": "ce qui limite une simulation",
  "When 10,000 buyers arrive at once, connections can take seconds to open: one process accepts a burst of new connections only so fast.":
    "Quand 10 000 acheteurs arrivent d’un coup, les connexions peuvent mettre plusieurs secondes à s’ouvrir : un processus n’accepte de nouvelles connexions qu’à un rythme limité.",
  "Every figure on this site is an observation of one environment, not a benchmark.":
    "Chaque chiffre du site est une observation dans un environnement donné, pas un benchmark.",
  "What limits a run, and what makes it fail":
    "Ce qui limite une simulation, et ce qui la fait échouer",
  "The figures below are measurements of the hosted demo, from a few runs each. They describe that one environment, not a benchmark or a guarantee.":
    "Les chiffres ci-dessous sont des mesures de la démo hébergée, sur quelques simulations chacun. Ils décrivent cet environnement précis ; ce n’est ni un benchmark ni une garantie.",
  "One API process.": "Un processus d’API.",
  " Once the stock is gone, the hosted demo answers about ":
    " Une fois le stock épuisé, la démo hébergée répond à environ ",
  " sold-out buyers per second from a steady stream.":
    " acheteurs refusés par seconde en flux continu.",
  "The database pool for successful buyers.": "Le pool de la base pour les gagnants.",
  " Each unit sold is first written to the database, through a small pool of PostgreSQL connections. Buyers who secure a unit are answered at about ":
    " Chaque unité vendue est d’abord enregistrée dans la base, via un petit pool de connexions PostgreSQL. Les acheteurs qui réservent une unité reçoivent une réponse à environ ",
  " per second, an order of magnitude below turned-away buyers.":
    " par seconde, soit un ordre de grandeur de moins que pour les acheteurs refusés.",
  "Everyone at once against a steady stream.": "Tous à la fois face au flux continu.",
  " In a steady stream, virtual users reuse their connections. When everyone arrives at once, each buyer opens a new connection, which costs the API more: about":
    " En flux continu, les utilisateurs virtuels réutilisent leurs connexions. Quand tout le monde arrive d’un coup, chaque acheteur ouvre une nouvelle connexion, ce qui coûte plus cher à l’API : environ",
  " sold-out buyers per second on the hosted demo.":
    " acheteurs refusés par seconde sur la démo hébergée.",
  "Stock.": "Stock.",
  " The more units a run sells, the more of its answers wait for the database, so the same traffic takes longer with more stock. In Surge 10k, the time within which 95 percent of answers arrived ranged":
    " Plus une simulation vend d’unités, plus ses réponses attendent la base : le même trafic prend donc plus de temps avec plus de stock. Sur « Afflux 10k », le délai sous lequel arrivaient 95 % des réponses variait",
  " across runs on the hosted demo.": " selon les simulations, sur la démo hébergée.",
  "A slow ERP does not slow purchases.": "Un ERP lent ne ralentit pas les achats.",
  " Only the worker calls the ERP. A slow or limited ERP makes the order backlog grow and drain at its pace, but buyers are answered before their order is confirmed: the run takes longer to finish, and the answers do not.":
    " Seul le worker appelle l’ERP. Un ERP lent ou limité fait monter les commandes en attente, qui se résorbent à son rythme, mais les acheteurs ont leur réponse avant la confirmation : la simulation dure plus longtemps, pas les réponses.",
  "Late answers.": "Réponses tardives.",
  " The load generator keeps listening for ":
    " Le générateur de charge continue d’écouter pendant ",
  " seconds after its sending window closes. If answers arrive later, they are not recorded and the run fails: the answers arrived too late.":
    " secondes après la fin de sa fenêtre d’envoi. Les réponses plus tardives ne sont pas enregistrées, et la simulation échoue : elles sont arrivées trop tard.",
  "The virtual-user limit.": "La limite d’utilisateurs virtuels.",
  " In a steady stream, each virtual user waits for its answer before sending again. When answers slow down, every virtual user can end up waiting; the load generator then cannot keep the rate, skips attempts, and the run reports its virtual-user limit.":
    " En flux continu, chaque utilisateur virtuel attend sa réponse avant de renvoyer une requête. Quand les réponses ralentissent, tous peuvent se retrouver à attendre ; le générateur de charge ne tient plus le débit, saute des tentatives, et la simulation signale sa limite d’utilisateurs virtuels.",
  "Before a visitor's run starts, the API compares it with these measured limits and refuses a run that is too heavy for the demo's server, rather than letting it fail.":
    "Avant de lancer la simulation d’un visiteur, l’API la compare à ces limites mesurées et la refuse si elle est trop lourde pour le serveur de la démo, plutôt que de la laisser échouer.",
  "What the comparisons do not show": "Ce que les comparaisons ne montrent pas",
  "The stores sit next to the API.": "Les systèmes de stockage sont à côté de l’API.",
  " PostgreSQL and Redis run on the API's machine. In a real deployment they would sit about a millisecond away, which would add about the same to every answer in both runs without changing what the comparison shows.":
    " PostgreSQL et Redis tournent sur la machine de l’API. Dans un déploiement réel, ils seraient à environ une milliseconde sur le réseau, ce qui ajouterait à peu près la même latence à chaque réponse des deux simulations sans changer ce que montre la comparaison.",
  "Winners are not faster with Redis.": "Les gagnants ne sont pas plus rapides avec Redis.",
  " A buyer who gets a unit pays the Redis decision, then the same database work.":
    " Un gagnant passe d’abord par la décision Redis, puis fait le même travail en base.",
  "A speed gap needs a database bottleneck":
    "Un écart de vitesse suppose un goulot d’étranglement dans la base",
  " that the demo does not have: several API instances sharing one database, a remote database behind a small connection pool, or a database busy with the rest of the shop.":
    " que la démo n’a pas : plusieurs instances d’API partageant une base, une base distante derrière un petit pool de connexions, ou une base occupée par le reste de la boutique.",
  "Redis's own ceiling is not measured.": "La limite propre à Redis n’est pas mesurée.",
  " It runs each command on one thread, so it too has a maximum rate of answers.":
    " Il exécute chaque commande sur un seul thread : lui aussi a donc un débit maximal.",
  "The run order is fixed:": "L’ordre des simulations est fixe :",
  " the demo as built always runs first, and the second run finds a warmer system. The measured gaps are far larger than that effect.":
    " la démo normale passe toujours en premier, et la seconde simulation trouve un système déjà chaud. Les écarts mesurés dépassent largement cet effet.",
  "The first comparison after a wake is slower,":
    "La première comparaison après le réveil est plus lente,",
  " in both runs: the processes start cold.":
    " dans les deux simulations : les processus démarrent à froid.",
  "The 45-second answer never occurs on the preset.":
    "La réponse à 45 secondes ne se produit jamais dans le scénario.",
  "Without the queue, the last winner waits about ":
    "Sans la file, le dernier gagnant attend environ ",
  " seconds, so the “secured, not yet confirmed” answer is covered by tests only.":
    " secondes : la réponse « réservé, pas encore confirmé » n’est donc couverte que par les tests.",
  "What a real system would add": "Ce qu’un système réel ajouterait",
  "The demo leaves out what it does not aim to demonstrate. A production purchase system should add:":
    "La démo laisse de côté ce qu’elle ne vise pas à montrer. Un système d’achat en production devrait ajouter :",
  "a waiting room in front of checkout, deciding how many buyers reach the purchase system and when;":
    "une salle d’attente devant le système d’achat, qui décide combien d’acheteurs y accèdent et quand ;",
  "temporary holds with an expiry, then payment: unpaid holds would expire automatically and free their unit, and a background job would check that Redis and the database agree;":
    "des réservations temporaires avec expiration, puis un paiement : les réservations impayées expireraient automatiquement et libéreraient leur unité ; une tâche vérifierait la cohérence entre Redis et la base ;",
  "several API instances, so one process no longer bounds how fast buyers are answered;":
    "plusieurs instances d’API pour dépasser la capacité de réponse d’un seul processus ;",
  "back-office protection coordinated across several workers;":
    "une protection du back-office coordonnée entre plusieurs workers ;",
  "bot protection, so the stock goes to people rather than scripts;":
    "une protection anti-bots, pour que le stock aille à de vraies personnes plutôt qu’à des scripts ;",
  "monitoring and alerts: the demo has its logs and nothing that pages anyone.":
    "de la supervision et des alertes : la démo a ses journaux, mais rien pour prévenir quelqu’un.",
  "Known defects": "Défauts connus",
  "How Checkout-Surge is built, how a run works, how the comparisons are measured, and how the demo is hosted. Written for engineers.":
    "L’architecture de Checkout-Surge, le déroulement d’une simulation, la mesure des comparaisons et l’hébergement de la démo. Écrit pour les développeurs.",
  "Under the hood": "Sous le capot",
  Architecture: "Architecture",
  "Five applications and two stores. The API owns the buy path. A worker owns everything after a buyer's answer. A simulated ERP plays the back office, a load generator plays the buyers, and the web app shows each run live.":
    "Cinq applications et deux systèmes de stockage. L’API gère le parcours d’achat. Un worker prend en charge tout ce qui suit la réponse à l’acheteur. Un ERP simulé tient le rôle du back-office, un générateur de charge celui des acheteurs, et l’application web affiche chaque simulation en direct.",
  "The buy path": "Le parcours d’achat",
  "Every checkout attempt first asks Redis to reserve its unit in one atomic operation, so competing attempts cannot spend the same unit. Once the stock is gone, buyers turned away are answered from Redis alone, without touching the database. A buyer who secures a unit is answered only after the API has written its reservation and order to PostgreSQL in one transaction and published the order to the queue.":
    "Chaque tentative demande d’abord à Redis de réserver une unité dans une opération atomique, pour empêcher deux tentatives concurrentes de prendre la même. Une fois le stock épuisé, Redis seul répond aux acheteurs refusés. Un gagnant ne reçoit sa réponse qu’une fois sa réservation et sa commande écrites dans PostgreSQL en une seule transaction, et la commande publiée dans la file.",
  "A buyer's answer includes more than the stock decision: waiting for a busy API and, for successful buyers, the database write. Run history shows the two apart: the reservation timing measures the decision, the response timing measures the whole answer.":
    "La réponse à l’acheteur ne se limite pas à la décision de stock : elle inclut l’attente d’une API occupée et, pour les gagnants, l’écriture en base. L’historique sépare les deux : le temps de réservation mesure la décision, le temps de réponse toute la réponse.",
  "Orders for unique reservations enter a BullMQ queue. Workers take that":
    "Les commandes issues de réservations uniques entrent dans une file BullMQ. Les workers traitent ces",
  backlog: "commandes en attente",
  " at a safe rate instead of forwarding the whole surge to the deliberately slow simulated ERP. Retries, worker limits, and the":
    " à un rythme sûr, au lieu de transmettre tout le pic à l’ERP simulé volontairement lent. Les nouvelles tentatives, les limites du worker et le",
  "circuit breaker": "disjoncteur",
  " keep downstream pressure bounded. Reserved work waits in the queue rather than being dropped; the one deliberate exception is a ":
    " limitent la pression en aval. Les commandes réservées attendent dans la file au lieu d’être abandonnées ; la seule exception voulue est une ",
  "run reset": "réinitialisation de simulation",
  ", which discards the whole run.": ", qui l’efface entièrement.",
  "The worker is configured with the ERP's declared capacity, as is common with mainstream ERP and SaaS APIs that publish their limits. When a downstream limit is unknown or variable, an adaptive client-side limiter, such as the adaptive retry mode of the AWS SDKs, is the appropriate technique. This demo deliberately shows the common case of a known limit.":
    "Le worker est configuré avec la capacité déclarée par l’ERP, comme c’est courant avec les principales API ERP et SaaS qui publient leurs limites. Si cette limite est inconnue ou variable, un limiteur adaptatif côté client, comme le mode de retry adaptatif des SDK AWS, est la bonne technique. Cette démo montre volontairement le cas courant d’une limite connue.",
  "An ERP call can also end without a usable answer, such as a timeout. The worker never retries such an ":
    "Un appel ERP peut se terminer sans réponse exploitable, par exemple après une expiration. Le worker ne rejoue jamais un tel ",
  "uncertain result": "résultat incertain",
  " blindly: it first asks the ERP's durable confirmation ledger whether that idempotency key already succeeded or was rejected, and replays the request with the same key only when the ERP has no record of it. That is what keeps a retry from creating a second order.":
    " aveuglément : il interroge d’abord le registre durable de l’ERP pour savoir si la clé d’idempotence a déjà réussi ou été refusée. Il ne rejoue la requête avec la même clé que si l’ERP n’en a aucune trace. C’est ce qui empêche une nouvelle tentative de créer une seconde commande.",
  "Safety nets": "Filets de sécurité",
  "Each failure the demo expects, and what catches it.":
    "Chaque panne prévue par la démo, et ce qui la rattrape.",
  "How a run works": "Le déroulement d’une simulation",
  Admission: "Admission",
  "One run at a time uses the demo, for every visitor. Before a run starts, the API estimates how long the chosen configuration would occupy the demo and rejects it when that conservative estimate exceeds the demo limit of at most ":
    "Une seule simulation à la fois occupe la démo, tous visiteurs confondus. Avant le démarrage, l’API estime combien de temps la configuration choisie occuperait la démo, et la refuse si cette estimation prudente dépasse la limite de ",
  " minutes. A visitor's custom run is also compared with the demo's measured capacity, and refused if it is not expected to complete. The estimate serves admission only: an accepted run that overruns it is neither stopped nor failed.":
    " minutes. Une simulation personnalisée est aussi comparée à la capacité mesurée et refusée si elle ne devrait pas aboutir. L’estimation sert uniquement à l’admission : une simulation acceptée qui la dépasse n’est ni arrêtée ni déclarée en échec.",
  "Once the load generator has sent its last attempt, the run enters a finishing phase and stops accepting new traffic. An empty queue is not the end. The run completes only when nothing is queued, processing, or waiting to retry, every uncertain ERP call has been resolved, every reservation has reached its durable record, and every confirmed order has its ":
    "Une fois que le générateur de charge a envoyé sa dernière tentative, la simulation passe en phase de finalisation et n’accepte plus de nouveau trafic. Une file vide ne signifie pas la fin. La simulation ne se termine que lorsque plus rien n’est en file, en traitement ou en attente de nouvelle tentative, que chaque appel ERP incertain est résolu, que chaque réservation a son enregistrement durable et que chaque commande confirmée a ses ",
  ". This phase has no elapsed-time deadline; the only time-based stop is the automatic reset below.":
    ". Cette phase n’a pas de limite de durée ; le seul arrêt lié au temps est la réinitialisation automatique décrite plus bas.",
  Success: "Réussite",
  "Every unique reservation must first reach a durable confirmed or failed order outcome. A run completes successfully only when the finishing phase has settled every remaining obligation and oversold units and failed or pending orders are all zero. Accepted responses can outnumber unique reservations when an":
    "Chaque réservation unique doit d’abord aboutir à une commande confirmée ou en échec, enregistrée durablement. La simulation ne réussit que si la finalisation a réglé toutes les obligations restantes, sans aucune unité survendue ni commande en échec ou en attente. Les réponses acceptées peuvent dépasser les réservations uniques lorsqu’un rejeu",
  idempotent: "idempotent",
  " replay returns the original result; the final result keeps those populations distinct and shows their invariant proof.":
    " renvoie le résultat initial ; le bilan distingue ces populations et présente la preuve des invariants.",
  "Grace period and reset": "Délai de grâce et réinitialisation",
  "From ": "À partir de ",
  " minutes after acceptance the dashboard shows a grace-period notice if the run is still unfinished. A run still unfinished at ":
    " minutes après l’acceptation, le tableau de bord affiche un avis de délai de grâce si la simulation n’est pas terminée. À ",
  "minutes is reset automatically so the next visitor can start. An admin can also reset a run manually. Either reset stops all demo work immediately and discards the run's data; one history line marked as cancelled remains.":
    "minutes, une simulation inachevée est automatiquement réinitialisée pour laisser la place au visiteur suivant. Un administrateur peut aussi la réinitialiser manuellement. Toute réinitialisation arrête immédiatement le travail et supprime les données ; seule une ligne marquée comme annulée reste dans l’historique.",
  "Comparisons: two runs in one slot": "Comparaisons : deux simulations dans un créneau",
  "A comparison preset runs its two modes as two chained runs on the same workload. The second run starts as soon as the first completes, in the same slot, and the visitor's run budget is charged once. Each run keeps its own time limit and automatic reset, and its own report.":
    "Un scénario de comparaison lance ses deux modes en deux simulations enchaînées, sur la même charge. La seconde démarre dès la fin de la première, dans le même créneau, et le budget de simulations du visiteur n’est débité qu’une fois. Chaque simulation garde sa propre limite de temps, sa réinitialisation automatique et son rapport.",
  "Live signals": "Indicateurs en direct",
  " shows checkout attempts starting at the load generator, so the opening surge is visible rather than inferred from completed responses.":
    " montre les tentatives dès leur départ du générateur de charge, pour que le pic initial soit visible au lieu d’être déduit des réponses terminées.",
  " shows remaining stock falling from the starting amount as reservation quantities are secured, alongside the authoritative oversell result.":
    " montre le stock restant baisser depuis sa valeur initiale à mesure que les réservations aboutissent, à côté du résultat de survente qui fait foi.",
  " shows reserved orders waiting for their first processing start, then draining as workers admit work safely.":
    " montre les commandes réservées qui attendent leur premier traitement, puis se résorbent quand les workers les prennent en charge à un rythme sûr.",
  "Confirmation convergence": "Convergence des confirmations",
  " shows those reservations reaching confirmed or failed durable outcomes; reservation-to-confirmation time explains the expected lag.":
    " montre ces réservations aboutir à un résultat durable, confirmé ou en échec ; le délai entre réservation et confirmation explique le décalage attendu.",
  "How the comparisons are measured": "Comment les comparaisons sont mesurées",
  "Each comparison runs one preset twice and switches one choice. A mode is a property of the run, set only by its comparison preset.":
    "Chaque comparaison lance deux fois un même scénario en changeant un seul choix. Le mode est une propriété de la simulation, fixée uniquement par son scénario de comparaison.",
  "Fairness rules": "Règles d’équité",
  "The selling window": "La fenêtre de vente",
  "The Redis comparison's database figures cover the selling window: from the run's start until every buyer has an answer. Transactions and time in queries come from PostgreSQL's statistics for the whole database (the API's, the worker's and recovery's work alike), and CPU time from PostgreSQL's own container. PostgreSQL publishes a busy connection's statistics about once a second, so up to the window's last second is left out, mostly the PostgreSQL run's decision reads: the figures understate the gap.":
    "Les chiffres de la base pour la comparaison Redis couvrent la fenêtre de vente : du début de la simulation jusqu’à ce que chaque acheteur ait sa réponse. Les transactions et le temps en requêtes viennent des statistiques PostgreSQL de toute la base (travail de l’API, du worker et de la reprise confondus), et le temps CPU du conteneur de PostgreSQL. PostgreSQL publie les statistiques d’une connexion occupée environ une fois par seconde : jusqu’à la dernière seconde de la fenêtre peut manquer, surtout des lectures de décision de la simulation PostgreSQL. Les chiffres sous-estiment donc l’écart.",
  "The buy-only pool": "Le pool réservé aux achats",
  "Both runs of the Redis comparison are served by the same two buy-only API processes, while one control process keeps run starts, resets, runner operations and recovery. With a single process, that process was the bottleneck in both modes, so the comparison would have measured the API rather than the stores. Ordinary runs and the queue comparison use the single API process.":
    "Les deux simulations de la comparaison Redis sont servies par les deux mêmes processus d’API réservés aux achats, tandis qu’un processus de contrôle prend en charge les démarrages, réinitialisations, opérations du générateur et reprises. Avec un seul processus, l’API limitait les deux modes : la comparaison aurait mesuré l’API plutôt que les systèmes de stockage. Les simulations ordinaires et la comparaison de la file de commandes utilisent un seul processus d’API.",
  "Pairs, medians and ranges": "Paires, médianes et fourchettes",
  "Each comparison was started repeatedly on a copy of this demo with the same Machines. A figure is the median across the pairs, with the lowest and highest pair in brackets, and a difference is claimed only when every pair agrees. The run order is fixed, with the demo as built first.":
    "Chaque comparaison a été lancée plusieurs fois sur une copie de cette démo, avec les mêmes machines. Chaque chiffre est la médiane des paires, avec le minimum et le maximum entre parenthèses, et un écart n’est annoncé que si toutes les paires concordent. L’ordre est fixe : la démo normale passe en premier.",
  "Queue comparison. {value0}": "Comparaison de la file de commandes. {value0}",
  "Redis comparison. {value0}": "Comparaison Redis. {value0}",
  "In every pair, all 500 orders were confirmed and no buyer went without an expected answer. Over whole Redis comparison runs, the PostgreSQL order queue drains about":
    "Dans chaque paire, les 500 commandes ont été confirmées et aucun acheteur n’est resté sans réponse attendue. Sur des simulations complètes de la comparaison Redis, la file de commandes PostgreSQL écoule environ",
  " orders per second against ": " commandes par seconde contre ",
  " with BullMQ; this happens after the selling window, so the figures above do not include it.":
    " avec BullMQ ; ce travail intervient après la fenêtre de vente et n’entre donc pas dans les chiffres ci-dessus.",
  Hosting: "Hébergement",
  "Sleep and wake.": "Veille et réveil.",
  " The core stops itself after a quiet period with no run. The next visitor wakes it through the gate, in about":
    " La machine principale s’arrête d’elle-même après un moment sans simulation. Le visiteur suivant la réveille via la passerelle, en environ",
  " seconds. A countdown under the header shows when it will sleep, with a button to keep it awake.":
    " secondes. Sous l’en-tête, un compte à rebours indique quand elle se mettra en veille, avec un bouton pour la garder éveillée.",
  "Sizes.": "Dimensionnement.",
  " The core Machine has ": " La machine principale dispose de ",
  ", and the runner Machine has ": ", et celle du générateur, de ",
  ", so the load generator never runs short of CPU while it sends.":
    ", pour que le générateur de charge ne manque jamais de CPU pendant ses envois.",
  "A warm start.": "Un démarrage à chaud.",
  " PostgreSQL saves the list of its cached pages when it stops and reloads them when it starts (pg_prewarm), and each buy-only process opens its connections before it accepts buyers.":
    " PostgreSQL sauvegarde la liste des pages en cache à l’arrêt et les recharge au démarrage avec pg_prewarm ; chaque processus d’achat ouvre ses connexions avant d’accepter des acheteurs.",
  "Disposable data.": "Données jetables.",
  " Run history and admin edits live on the core's disk with no backup: a reinstall on new servers starts empty.":
    " L’historique et les modifications d’administration sont stockés sur le disque de la machine principale, sans sauvegarde : une réinstallation sur de nouveaux serveurs repart de zéro.",
  Glossary: "Glossaire",
  "Checkout-Surge demo": "Démo Checkout\u2011Surge",
  "How the surge stays safe": "Comment le pic reste sous contrôle",
  "Simulated buyers compete for limited stock: an in-memory store (Redis) decides each attempt in one step, so no unit is sold twice, and orders wait in a queue, so the slow, simulated back office is never flooded. The results describe this demo,":
    "Des acheteurs simulés se disputent un stock limité. Une base en mémoire (Redis) décide de chaque tentative en une seule opération : aucune unité n’est vendue deux fois. Les commandes attendent dans une file : le back-office, lent et simulé, n’est jamais submergé. Les résultats décrivent cette démo,",
  "at its scale": "à son échelle",
  "Live watch": "Suivi en direct",
  "Follow the run from live activity to the final result; technical details are available below.":
    "Suivez la simulation de l’activité en direct jusqu’au résultat final ; détails techniques ci-dessous.",
  "Admin console": "Console d’administration",
  "Protected operator controls and service state for supervised demo runs.":
    "Contrôles protégés et état des services pour les simulations supervisées.",
  "See which simulation ran, when it ran, and what happened, with one saved report for each run.":
    "Retrouvez chaque simulation lancée, sa date et son déroulé, avec un rapport enregistré pour chacune.",
  "History unavailable": "Historique indisponible",
  "This is a simulation of the purchase system behind a waiting room: the buyers it lets through compete for limited stock, and orders reach a simulated order-processing system.":
    "Cette simulation reproduit le système d’achat derrière une salle d’attente : les acheteurs admis se disputent un stock limité, et les commandes partent vers un système de traitement simulé.",
  "Overall duration: ": "Durée totale : ",
  "Run history detail": "Détail de la simulation",
  "Detail unavailable": "Détail indisponible",
  "This report is not available": "Ce rapport est indisponible",
  "We could not load a saved report from this link.":
    "Impossible de charger un rapport enregistré depuis ce lien.",
  "Page not found": "Page introuvable",
  "We could not find this page or saved run report.":
    "Cette page ou ce rapport de simulation est introuvable.",
  "Go to the demo home": "Aller à l’accueil de la démo",
  "On this page": "Sur cette page",
  "Architecture diagram scrolls sideways.": "Le schéma d’architecture défile horizontalement.",
  "Scrollable architecture diagram": "Schéma d’architecture à défilement horizontal",
  "Checkout-Surge request and processing paths":
    "Parcours des requêtes et des traitements Checkout-Surge",
  "Simulated buyers send checkout attempts to the API. For every attempt, Redis makes the in-memory atomic stock decision, and a buyer turned away is answered after that step alone. For a buyer who secures a unit, the API first writes the reservation and its order to PostgreSQL in one transaction and publishes the order to the BullMQ queue. The worker takes orders from the queue to the simulated ERP and records their outcomes in PostgreSQL.":
    "Les acheteurs simulés envoient leurs tentatives d’achat à l’API. Pour chacune, Redis décide du stock en mémoire, de façon atomique ; un acheteur refusé reçoit sa réponse dès cette étape. Pour un gagnant, l’API écrit d’abord la réservation et la commande en une transaction PostgreSQL, puis publie la commande dans la file BullMQ. Le worker transmet les commandes de la file à l’ERP simulé et enregistre leurs résultats dans PostgreSQL.",
  "Every attempt: atomic stock decision.": "Chaque tentative : décision atomique de stock.",
  "Turned-away buyers are answered after this step alone.":
    "Les acheteurs refusés ont leur réponse dès cette étape.",
  "Successful buyer: order job": "Gagnant : tâche de commande",
  "Successful buyer:": "Gagnant :",
  "one transaction": "une transaction",
  "Order outcomes": "Résultats des commandes",
  "Simulated buyers": "Acheteurs simulés",
  "Redis decision": "Décision Redis",
  "BullMQ queue": "File BullMQ",
  Worker: "Worker",
  "Buyers turned away: Redis only. Buyers who secure a unit: the Redis decision, then one PostgreSQL transaction and a queue publish before the answer. Slow path: the worker confirms queued orders with the simulated ERP and records their outcomes in PostgreSQL.":
    "Acheteurs refusés : Redis uniquement. Gagnants : décision Redis, transaction PostgreSQL et publication dans la file avant la réponse. Parcours lent : le worker fait confirmer les commandes par l’ERP simulé et enregistre les résultats dans PostgreSQL.",
  "Demand is {value0} times the stock, and it arrives {value1} times faster than the back office confirms orders. The strips are to scale.":
    "La demande représente {value0} fois le stock et arrive {value1} fois plus vite que le back-office ne confirme les commandes. Les barres sont à l’échelle.",
  "A real purchase has five steps. The demo runs the stock decision and the order for real, has no payment step, simulates the back office and the emails, and leaves the waiting room out: its buyers are the ones a waiting room would let through.":
    "Un achat réel compte cinq étapes. La démo exécute réellement la décision de stock et la commande, n’a pas d’étape de paiement, simule le back-office et les e-mails, et laisse de côté la salle d’attente : ses acheteurs sont ceux qu’une salle d’attente laisserait passer.",
  "A visitor always reaches the gate first. While the demo sleeps, the gate shows its own page and wakes the core Machine, in about {value0} seconds; then it relays every request to it. The core Machine holds the whole system under test. The runner Machine holds the load generator, which the API starts for each run, so the simulated buyers never share the core's CPU. An hourly guard stops a Machine left awake or broken.":
    "Un visiteur passe toujours d’abord par la passerelle. Quand la démo est en veille, la passerelle affiche sa propre page et réveille la machine principale en environ {value0} secondes, puis lui relaie chaque requête. La machine principale héberge tout le système testé. La machine du générateur héberge le générateur de charge, que l’API lance à chaque simulation : les acheteurs simulés ne partagent jamais le CPU de la machine principale. Toutes les heures, un garde-fou arrête toute machine restée éveillée ou en panne.",
  "A browser": "Un navigateur",
  Visitor: "Visiteur",
  "The only public address: its own pages while the core sleeps, then a relay":
    "L’unique adresse publique : ses pages pendant la veille, puis un relais",
  Gate: "Passerelle",
  "Core Machine": "Machine principale",
  " · sleeps when nobody uses it": " · en veille quand personne ne l’utilise",
  "The load generator (k6): started for each run, stopped after it":
    "Le générateur de charge (k6) : lancé à chaque simulation, arrêté ensuite",
  "Runner Machine": "Machine du générateur",
  "· pairs ranged ": "· selon les paires : ",
  Figure: "Mesure",
  ", median (range)": ", médiane (plage)",
  "The Redis comparison's {value0} buyers, one dot per {value1}. With Redis, the buyers turned away are answered from memory, and only the {value2} winners reach the database. With the stock in PostgreSQL, every buyer does, if only for a quick read.":
    "Les {value0} acheteurs de la comparaison Redis, un point pour {value1}. Avec Redis, les acheteurs refusés ont leur réponse depuis la mémoire, et seuls les {value2} gagnants atteignent la base. Avec le stock dans PostgreSQL, tous l’atteignent, ne serait-ce que pour une lecture rapide.",
  "Answered from memory": "Réponse depuis la mémoire",
  "Reaches the database": "Atteint la base",
  "Who waits for the back office, in the queue comparison (medians of measured runs). Same {value0} orders and the same back-office pace in both runs, so the back office takes as long either way. With the queue, buyers have their answer long before. Without it, winners wait for their turn at the back office.":
    "Qui attend le back-office, dans la comparaison de la file de commandes (médianes des simulations mesurées). Mêmes {value0} commandes et même rythme du back-office dans les deux simulations : il met donc le même temps dans les deux cas. Avec la file, les acheteurs ont leur réponse bien avant. Sans elle, les gagnants font la queue devant le back-office.",
  "Every buyer has an answer within": "Chaque acheteur reçoit sa réponse en moins de",
  "The back office confirms the slowest order after":
    "Le back-office confirme la commande la plus lente après",
  "One purchase, three moments. Every buyer gets a stock decision made in memory, and a buyer turned away is answered right there, without the database. A buyer who gets a unit is answered once the order is saved. The order then waits in a queue, and a worker has the back office confirm it at the back office's own pace. The waiting room in front is not modelled, and the back office is simulated.":
    "Un achat, trois moments. Chaque acheteur reçoit une décision de stock prise en mémoire ; s’il est refusé, il a sa réponse sur-le-champ, sans passer par la base. Un gagnant a sa réponse une fois la commande enregistrée. Celle-ci attend ensuite dans une file, et un worker la fait confirmer au rythme du back-office. La salle d’attente en amont n’est pas modélisée, et le back-office est simulé.",
  "“Sold out”": "« Épuisé »",
  "answered from memory": "réponse depuis la mémoire",
  "Every buyer": "Chaque acheteur",
  "lets buyers in": "laisse entrer les acheteurs",
  "Waiting room": "Salle d’attente",
  "a repeat click gets the same answer": "un nouveau clic reçoit la même réponse",
  Checkout: "Système d’achat",
  "in memory, in one step": "en mémoire, en une opération",
  "Stock decision": "Décision de stock",
  "“You got it”": "« Réservé »",
  "once the order is saved": "une fois la commande enregistrée",
  "If a unit is left": "S’il reste une unité",
  "in the database": "dans la base de données",
  "Order saved": "Commande enregistrée",
  "“Confirmed”": "« Confirmé »",
  "by email, simulated": "par e-mail simulé",
  "Then, at the back office's pace": "Puis, au rythme du back-office",
  "Order queue": "File de commandes",
  "Back office": "Back-office",
  "Two buyers are both told they got the last unit, and every turned-away buyer keeps the database busy just to hear “sold out”.":
    "Deux acheteurs apprennent chacun qu’ils ont la dernière unité, et chaque acheteur refusé occupe la base juste pour s’entendre dire « épuisé ».",
  "Stock decided in memory": "Stock décidé en mémoire",
  "Each attempt is decided in memory, in one step, so no unit is sold twice, and turned-away buyers never reach the database.":
    "Chaque tentative est décidée en mémoire, en une opération : aucune unité n’est vendue deux fois, et les acheteurs refusés n’atteignent jamais la base.",
  "Winners stare at a spinner while a back office that confirms {pace} orders a second is pushed past its limit.":
    "Les gagnants regardent tourner une roue de chargement pendant qu’un back-office qui confirme {pace} commandes par seconde est poussé au-delà de ses limites.",
  "“Yes” now, confirm later": "« Oui » tout de suite, confirmation ensuite",
  "The order is saved and the buyer answered at once; a queue hands orders to the back office at its own pace.":
    "La commande est enregistrée et l’acheteur reçoit immédiatement sa réponse ; une file transmet les commandes au rythme du back-office.",
  "A double click, or a retry after a timeout, buys twice.":
    "Un double clic, ou une nouvelle tentative après un délai dépassé, achète deux fois.",
  "Safe retries": "Nouvelles tentatives sans risque",
  "Every request carries a key, so a repeat gets the first answer again instead of acting again.":
    "Chaque requête porte une clé : une requête répétée reçoit la première réponse au lieu d’agir à nouveau.",
  "Three numbers": "Trois chiffres",
  "1. Waiting room": "1. Salle d’attente",
  "2. Stock in memory": "2. Stock en mémoire",
  "3. Yes now, confirm later": "3. Oui tout de suite, confirmation ensuite",
  "4. Safe retries": "4. Nouvelles tentatives sans risque",
  "At the demo's scale": "À l’échelle de la démo",
  "How it is measured": "Comment les résultats sont mesurés",
  "Not modelled": "Non modélisé",
  "“Everyone at once” and “Steady stream” play its releases":
    "« Tous à la fois » et « Flux continu » simulent les admissions",
  Yes: "Oui",
  "Every preset": "Tous les scénarios",
  "The backlog chart, Slow ERP, Laggy ERP":
    "Le graphique des commandes en attente, « ERP lent », « ERP à forte latence »",
  "Duplicate-click storm, the ERP's ledger": "« Avalanche de doubles clics », le registre de l’ERP",
  "Real and simulated": "Réel et simulé",
  "What limits a run": "Les limites d’une simulation",
  "A run started at the very moment the demo goes to sleep is interrupted, then settled at the next wake.":
    "Une simulation lancée à l’instant précis où la démo se met en veille est interrompue, puis finalisée au réveil suivant.",
  "Right after “stay awake”, the countdown can show the old deadline for a few seconds.":
    "Juste après « Rester actif », le compte à rebours peut afficher l’ancienne échéance pendant quelques secondes.",
  "Run history and admin edits are lost when the demo is reinstalled on new servers.":
    "L’historique et les modifications d’administration sont perdus si la démo est réinstallée sur de nouveaux serveurs.",
  "The custom-run form's field messages follow the browser's language, while the surrounding copy follows the selected site language.":
    "Dans le formulaire de simulation personnalisée, les messages des champs suivent la langue du navigateur, et le reste du texte, la langue choisie sur le site.",
  "Web pages and live view": "Pages web et suivi en direct",
  "Redis, one atomic script per attempt": "Redis, un script atomique par tentative",
  "Durable records": "Enregistrements durables",
  "Order queue and worker": "File de commandes et worker",
  "BullMQ on Redis": "BullMQ sur Redis",
  "Live updates": "Mises à jour en direct",
  "Server-sent events, Redis Pub/Sub": "Server-Sent Events, Redis Pub/Sub",
  "k6, on its own Machine": "k6 sur une machine distincte",
  "Shared contracts": "Contrats partagés",
  "A double click, a timeout or a client retry":
    "Un double clic, un délai dépassé ou une nouvelle tentative du client",
  "The idempotency key replays the original reservation; nothing is bought twice.":
    "La clé d’idempotence rejoue la réservation initiale ; rien n’est acheté deux fois.",
  "The queue publish is lost after the order is saved":
    "La publication dans la file est perdue après l’enregistrement de la commande",
  "A dispatch scanner finds the committed order and publishes it again.":
    "Un scanner de publication retrouve la commande enregistrée et la republie.",
  "The database fails after Redis reserved a unit":
    "La base tombe en panne après la réservation Redis",
  "The reservation waits for its durable record, and recovery writes it later. A run cannot finish while one remains.":
    "La réservation attend son enregistrement durable ; la reprise l’écrit ensuite. La simulation ne peut pas se terminer tant qu’il en reste.",
  "The ERP call ends without an answer": "L’appel ERP se termine sans réponse",
  "The worker checks the ERP's confirmation ledger before any replay, with the same key.":
    "Le worker consulte le registre de confirmation de l’ERP avant tout rejeu, avec la même clé.",
  "The ERP is slow or at its limit": "L’ERP est lent ou atteint sa limite",
  "The queue's rate limit, the worker's in-flight limits and capacity cooldowns hold the work back.":
    "La limite de débit de la file, les plafonds d’appels simultanés du worker et les pauses de capacité freinent le travail.",
  "The ERP is down": "L’ERP est indisponible",
  "A circuit breaker pauses calls, then probes for recovery.":
    "Un disjoncteur suspend les appels, puis teste le rétablissement.",
  "The worker restarts": "Le worker redémarre",
  "The cooldown and circuit deadlines are stored durably and restored at startup.":
    "Les échéances de pause et du disjoncteur sont enregistrées durablement puis restaurées au démarrage.",
  "A simulated email is missing": "Il manque un e-mail simulé",
  "A notification scanner queues it again.": "Un scanner de notifications le remet dans la file.",
  "A run never finishes": "Une simulation ne se termine jamais",
  "It is reset automatically at {minutes} minutes, so the next visitor can start.":
    "Elle est réinitialisée automatiquement au bout de {minutes} minutes, pour que le visiteur suivant puisse en lancer une.",
  "The demo as built": "La démo normale",
  "Every ordinary run, and run 1 of both comparisons: Redis decides the stock and holds the order queue (BullMQ); the worker calls the ERP after the buyer's answer.":
    "Toutes les simulations ordinaires, et la simulation 1 des deux comparaisons : Redis décide du stock et héberge la file de commandes (BullMQ) ; le worker appelle l’ERP après la réponse à l’acheteur.",
  "Run 2 of the queue comparison: a winner's request waits until the same worker has the order confirmed by the ERP, at the ERP's pace. After 45 seconds it is told “secured, not yet confirmed”, and the order is confirmed later as usual.":
    "La simulation 2 de la comparaison de la file de commandes : la requête d’un gagnant attend que le même worker fasse confirmer la commande par l’ERP, au rythme de l’ERP. Au bout de 45 secondes, elle reçoit « réservé, pas encore confirmé », et la commande est confirmée plus tard, comme d’habitude.",
  "Run 2 of the Redis comparison: PostgreSQL decides the stock and holds the order queue. Redis still carries the live counters and the notifications.":
    "La simulation 2 de la comparaison Redis : PostgreSQL décide du stock et héberge la file de commandes. Redis gère toujours les compteurs en direct et les notifications.",
  "Same Machines, same preset, same API processes and connection pools in both runs.":
    "Les mêmes machines, le même scénario, les mêmes processus d’API et pools de connexions dans les deux simulations.",
  "Same protections in every mode: idempotency, the run fence, the bookkeeping, and the reservation and order recorded before “yes”.":
    "Les mêmes protections dans chaque mode : idempotence, isolation de simulation, comptabilité, réservation et commande enregistrées avant le « oui ».",
  "A standard PostgreSQL design, not a strawman: one stock row, a conditional decrement, a read-only check first, and no write for a sold-out answer.":
    "Une conception PostgreSQL courante, et non une caricature : une ligne de stock, un décrément conditionnel, une vérification préalable en lecture seule et aucune écriture pour une réponse « épuisé ».",
  "A winner commits in one transaction on a reserved connection, in both modes.":
    "Un gagnant valide tout en une seule transaction, sur une connexion réservée, dans les deux modes.",
  "Without the queue, the request waits for the same worker instead of calling the ERP itself, so the ERP client and its pacing stay the same.":
    "Sans la file, la requête attend le même worker plutôt que d’appeler directement l’ERP : le client ERP et son rythme restent identiques.",
  "Equal groups: all winners, or all buyers, in both runs; never only those who got a given answer.":
    "Des groupes identiques : tous les gagnants, ou tous les acheteurs, dans les deux simulations ; jamais seulement ceux qui ont reçu une réponse donnée.",
  "Enterprise resource planning: the back-office system represented here by deliberately slow simulated behavior.":
    "Progiciel de gestion intégré : le back-office représenté ici par une simulation volontairement lente.",
  "Transactions per second; here, the simulated ERP call capacity.":
    "Transactions par seconde ; ici, la capacité d’appels de l’ERP simulé.",
  "The value that 95 percent of recorded observations are at or below for the named measurement boundary.":
    "La valeur sous laquelle se trouvent 95 % des observations enregistrées pour la mesure indiquée.",
  "Virtual user: a reusable load-generator worker that runs scenario iterations and may run multiple checkout attempts.":
    "Utilisateur virtuel : un worker réutilisable du générateur de charge qui exécute les itérations du scénario et peut effectuer plusieurs tentatives d’achat.",
  "Circuit breaker": "Disjoncteur",
  "Protection that pauses calls after repeated downstream failures, then probes for recovery.":
    "Protection qui suspend les appels après des pannes répétées en aval, puis teste le rétablissement.",
  "Limiting how quickly queued work enters a slower dependency so a surge does not overwhelm it.":
    "Limiter le rythme auquel le travail en file arrive à une dépendance plus lente, pour qu’un pic ne la submerge pas.",
  Idempotency: "Idempotence",
  "Repeating the same eligible request returns its original result instead of acting again: a replayed checkout returns its reservation, and a replayed ERP call cannot create a second order.":
    "Répéter une requête admissible renvoie son résultat initial sans agir à nouveau : un achat rejoué renvoie sa réservation, et un appel ERP rejoué ne crée jamais une seconde commande.",
  "Uncertain result": "Résultat incertain",
  "An ERP call whose outcome never reached the worker. It is verified against the ERP’s confirmation ledger before any replay.":
    "Un appel ERP dont le résultat n’a jamais atteint le worker. Il est vérifié dans le registre de confirmation de l’ERP avant tout rejeu.",
  Projection: "Projection",
  "A read-ready view assembled from authoritative run data for the dashboard.":
    "Une vue prête à la lecture, construite pour le tableau de bord à partir des données de référence de la simulation.",
  Recovery: "Reprise",
  "Rebuilding current state after a missed update, or safely retrying incomplete durable work.":
    "Reconstruire l’état actuel après une mise à jour manquée, ou reprendre sans risque un travail durable incomplet.",
  Drain: "Finalisation",
  "Finishing a run after traffic stops: queued work, retries, uncertain ERP calls, reservations awaiting their durable record, and missing simulated emails must all be settled before the run completes.":
    "Terminer une simulation après l’arrêt du trafic : travail en file, nouvelles tentatives, appels ERP incertains, réservations en attente d’enregistrement durable et e-mails simulés manquants doivent tous être réglés avant qu’elle ne s’achève.",
  "Reservation awaiting its durable record": "Réservation en attente d’enregistrement durable",
  "A unit Redis has reserved whose reservation and order PostgreSQL has not recorded yet, for example while the database is briefly unavailable. Recovery records it later, and a run cannot finish while one remains.":
    "Une unité réservée par Redis dont PostgreSQL n’a pas encore enregistré la réservation et la commande, par exemple pendant une brève indisponibilité. La reprise l’enregistre ensuite, et la simulation ne peut pas finir tant qu’il en reste.",
  "Reservation versus confirmation": "Réservation et confirmation",
  "A reservation secures scarce stock in one atomic decision and creates its order at once; confirmation is the later successful order state after queued processing. Failure is a separate durable outcome.":
    "Une réservation bloque une unité d’un stock limité en une décision atomique et crée aussitôt sa commande ; la confirmation est l’état de réussite ultérieur de la commande, après son traitement en file. L’échec est un résultat durable distinct.",
  "Run report": "Rapport de simulation",
  "Hold and payment": "Réservation et paiement",
  "lets buyers in at a pace": "admet les acheteurs à un rythme maîtrisé",
  "one unit each, never more": "une unité chacun, pas plus",
  "no payment: the order comes at once": "sans paiement : commande immédiate",
  Order: "Commande",
  "saved before the answer": "enregistrée avant la réponse",
  "Confirmation and email": "Confirmation et e-mail",
  "by the back office, at its pace": "par le back-office, à son rythme",
  "Web pages": "Pages web",
  "Buy-only API pool (Redis comparison)": "Pool d’API d’achat (comparaison Redis)",
  "Shown live": "Visible en direct",
  "Compared live": "Comparé en direct",
  Simplified: "Simplifié",
  Simulated: "Simulé",
  "6 dedicated vCPUs and 12 GB": "6 vCPU dédiés et 12 Go",
  "8 dedicated vCPUs and 16 GB": "8 vCPU dédiés et 16 Go",
  "Median of 4 measured pairs on a copy of this demo, after a warm-up pair (October 2026).":
    "Médiane de 4 paires mesurées sur une copie de cette démo, après une paire d’échauffement (octobre 2026).",
  "Winners' time to an answer, 95th percentile": "Délai de réponse des gagnants, 95e percentile",
  "Winners' time to an answer, average": "Délai de réponse moyen des gagnants",
  "Back office's pace (limit 20 per second)": "Rythme du back-office (max. 20 par seconde)",
  "Database transactions while selling": "Transactions en base pendant la vente",
  "Time in database queries, waits for the stock row included":
    "Temps passé en requêtes, attente de la ligne de stock comprise",
  "Database CPU time": "Temps processeur de la base",
  "Turned-away buyers' time to an answer, average": "Délai de réponse moyen des acheteurs refusés",
  "Median of 4 measured pairs on a copy of this demo, each the first comparison after it woke up (October 2026).":
    "Médiane de 4 paires mesurées sur une copie de cette démo, chaque fois la première comparaison après son réveil (octobre 2026).",
  "Median of 4 measured pairs on a copy of this demo, each right after a cold pair (October 2026).":
    "Médiane de 4 paires mesurées sur une copie de cette démo, chacune juste après une paire à froid (octobre 2026).",
  "Medians of 4 measured pairs per comparison on a copy of this demo (October 2026); each Redis pair was the first comparison after the demo woke up. Your run will differ a little.":
    "Médianes de 4 paires mesurées par comparaison sur une copie de cette démo (octobre 2026) ; chaque paire Redis était la première comparaison après le réveil de la démo. Votre simulation donnera des chiffres un peu différents.",
  "between about 8 and 14 seconds": "entre 8 et 14 secondes environ",
  "per second": "par seconde",
  "about {ratio} times": "environ {ratio} fois",
  "{buyers} buyers": "{buyers} acheteurs",
  "{units} units": "{units} unités",
  "{pace} orders per second": "{pace} commandes/s",
  "in about a second": "en une seconde environ",
  "for sale": "en vente",
  "confirmed by the back office (simulated)": "confirmées par le back-office (simulé)",
  "{memory} stop in memory with “sold out”; {database} reach the database":
    "{memory} s’arrêtent en mémoire avec « épuisé » ; {database} atteignent la base",
  "All {buyers} reach the database": "Les {buyers} atteignent tous la base",
  Practice: "Pratique",
  "In every run": "À chaque simulation",
  "Where to see it": "Où le voir",
  "Winners' time to an answer": "Délai de réponse des gagnants",
  "From a winner's click to the answer, over all winners. The 95th percentile is the time within which 95 % of them were answered.":
    "Du clic d’un gagnant à sa réponse, pour tous les gagnants. Le 95e percentile est le délai dans lequel 95 % d’entre eux ont reçu leur réponse.",
  "The slowest answer of the run, winners and turned-away buyers alike.":
    "La réponse la plus lente de la simulation, gagnants et acheteurs refusés confondus.",
  "The back office's pace": "Le rythme du back-office",
  "Orders confirmed per second, from the first buyer to the last confirmation, against its limit of 20.":
    "Commandes confirmées par seconde, du premier acheteur à la dernière confirmation, face à sa limite de 20.",
  "Slowest order": "Commande la plus lente",
  "The longest time from an order's “yes” to its confirmation by the back office.":
    "Le délai le plus long entre le « oui » d’une commande et sa confirmation par le back-office.",
  "×4.7 vs run 1": "×4,7 vs simulation 1",
  "On Watch and in the reports: run 2's figure as a multiple of run 1's.":
    "Dans le suivi en direct et les rapports : la mesure de la simulation 2, en multiple de celle de la simulation 1.",
  "While selling": "Pendant la vente",
  "From the run's start until every buyer has an answer: the database figures cover this window.":
    "Du lancement de la simulation jusqu’à ce que chaque acheteur ait sa réponse : les chiffres de la base couvrent cette fenêtre.",
  "A transaction": "Une transaction",
  "One unit of database work that commits or rolls back, counted for the whole database: the API's, the worker's and recovery's work alike.":
    "Une unité de travail validée ou annulée, comptée pour toute la base : API, worker et reprise compris.",
  "Time in database queries": "Temps passé en requêtes",
  "How long the database's connections spent running statements, waits for the stock row included. Connections work in parallel, so it can exceed the window.":
    "Le temps passé par les connexions à exécuter des requêtes, attente de la ligne de stock comprise. Elles travaillent en parallèle : ce total peut dépasser la durée de la fenêtre.",
  "The processor time of the database's own container.":
    "Le temps processeur du conteneur de la base.",
  "Time to an answer": "Délai de réponse",
  "From a buyer's click to the answer, averaged over all turned-away buyers, or over all winners.":
    "Du clic à la réponse, en moyenne sur tous les acheteurs refusés ou sur tous les gagnants.",
  "Next: limits and known defects": "Suite : limites et défauts connus",
  "The problem": "Le problème",
  "The standard answer": "La solution courante",
  "Why it is standard": "Pourquoi c’est courant",
  "What it brings": "Ce que cela apporte",
  "What it costs": "Ce que cela coûte",
  "How they are measured": "Comment les résultats sont mesurés",
  "The PostgreSQL order queue confirms orders about {drain}% slower than BullMQ ({postgres} against {bullmq}), after the measured window: the Redis comparison's second run takes a little longer to finish.":
    "La file PostgreSQL confirme les commandes environ {drain} % moins vite que BullMQ ({postgres} contre {bullmq}), après la fenêtre mesurée : la seconde simulation de la comparaison Redis met un peu plus longtemps à se terminer.",
  "What they do not show": "Ce qu’elles ne montrent pas",
  "duration not recorded": "durée non enregistrée",
  "No finished result exists for this run.": "Cette simulation n’a aucun résultat final.",
};
