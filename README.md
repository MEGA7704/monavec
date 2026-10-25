# AVEC Manager Pro — GitHub + Cloudflare Pages

## Paramètres de build EXACTS (Cloudflare Pages, Git intégré)

- Framework preset : **None**
- Production branch : **main**
- Root directory : **/** (racine du dépôt)
- Build command : **laisser vide** (aucune commande)
- Build output directory : **public**
- Functions directory : **AUCUN** (mode avancé `public/_worker.js`)
- Node.js : non requis pour le build

Le fichier `wrangler.toml` lie les ressources existantes :

- KV Binding : **avec_kv** → `4a4e87291203410187ba0052f4f6abae`
- D1 Binding : **avec_d1** → `bd6bdc50-08de-491f-b989-56a8c6557244`

Vérifier les bindings dans Cloudflare Pages > projet > Settings > Bindings, pour Production **et** Preview si nécessaire. Si Cloudflare ne reprend pas automatiquement les bindings du TOML, les créer dans l'interface avec les mêmes noms.

## Préparation indispensable de D1

Depuis la racine du dépôt après `npm install` :

```bash
npx wrangler d1 migrations apply avec_d1 --remote
```

Ou coller le contenu de `migrations/0001_init.sql` dans Cloudflare D1 > avec_d1 > Console, avant la première connexion. Ne pas exécuter les deux voies de manière destructive. La migration crée les tables ; elle ne supprime aucune table existante.

## Secrets Cloudflare — jamais dans GitHub

Dans Cloudflare Pages > votre projet > Settings > Variables and Secrets > Add, type **Secret** :

- `SUPERADMIN_INITIAL_PASSWORD` : **choisir soi-même un mot de passe robuste d'au moins 12 caractères**, jamais publié dans le ZIP.
- `SESSION_PEPPER` : **valeur aléatoire forte d'au moins 32 octets**, distincte du mot de passe.

Déployer à nouveau après ajout des secrets. Ne pas créer de variables publiques `VITE_*` contenant ces valeurs.

Le compte `mega@service.local` est créé automatiquement côté serveur à la première tentative de connexion si aucune ligne Super Admin n'existe, avec hachage PBKDF2 et sel aléatoire. **Le secret initial n'est utilisé qu'au premier amorçage** ; pour le changer ensuite, utiliser Paramètres > Changer mon mot de passe. Après modification, toutes les sessions sont révoquées. L'adresse `.local` est une identité technique et ne reçoit pas d'e-mails.

## Fonctionnement de base

- Connexion `POST /api/login` et cookie HttpOnly/Secure/SameSite=Lax ; le serveur protège `/api/load` et `/api/save`.
- Les écritures exigent le jeton CSRF obtenu lors de la connexion, stocké en mémoire uniquement.
- Journal d'audit D1, limitation des tentatives par IP et par compte sur 15 minutes.
- Les administrateurs créent des agents, le Super Admin crée les administrateurs et gère les plans.
- Les demandes de réinitialisation depuis la page de connexion sont enregistrées dans D1, **sans envoi d'e-mail automatique**. Il faut se connecter dans l'espace Super Admin pour les traiter.
- Free 10 jours, Standard 30 jours (2 600 F), Business 365 jours (25 600 F). Paiements Wave par liens ; activation manuelle par le Super Admin. **Pas de validation automatique de paiement Wave.**
- Plan Free : popup promotionnelle au premier accès à une section, puis au maximum une fois toutes les 15 minutes tant que la page reste ouverte.

## Périmètre réel de cette première version

**Implémenté :** associations, membres, cycles, réunions, épargne par parts, prêts à intérêt forfaitaire, remboursements intérêts puis capital, solidarité, dépenses, aperçu de partage, synthèse financière, utilisateurs, plans, sessions et audit.

**À compléter avant usage financier réel :** moteur transactionnel comptable à double entrée et contrôles de trésorerie/encours, validations collectives des prêts, pénalités configurables, intérêts dégressifs, clôture définitive avec gestion des impayés et pertes, distribution effective, reçus PDF, rapprochements, pagination profonde, export XLSX/PDF et contrôles de concurrence des opérations financières. La simulation de partage est **non exécutoire**. Cette version est un socle opérationnel technique, **pas encore un logiciel certifié pour détenir ou distribuer des fonds réels**.

**Prudence :** les données D1 sont sensibles. Activer des sauvegardes/restaurations, tester sur un environnement séparé, et vérifier le cadre juridique/réglementaire des AVEC en Côte d'Ivoire.


## Correctif PBKDF2 Cloudflare (octobre 2026)

`public/_worker.js` utilise 100 000 itérations PBKDF2-SHA256, maximum accepté par le runtime constaté (erreur avec 310 000). Le mot de passe initial du Super Admin reste un secret Cloudflare (`SUPERADMIN_INITIAL_PASSWORD`) et ne figure pas dans les sources. Si des comptes avaient déjà été hachés avec 310 000 itérations dans un autre environnement, une migration/réinitialisation sécurisée de ces comptes est requise, car changer uniquement le nombre d’itérations ne préservera pas leurs hashes. Cette correction n’efface aucune table D1.

## Inscription autonome des AVEC

Depuis la page de connexion, le bouton **Créer mon AVEC et mon compte administrateur** ouvre le formulaire d'inscription. La route publique `GET /api/register-token` génère un jeton à durée limitée (KV), et `POST /api/register` crée atomiquement l'association et son compte `admin` dans D1, avec un plan **Free de 10 jours**. L'inscription ne peut attribuer ni le rôle Super Admin, ni un abonnement payant. Les sessions et le contrôle des données restent séparés par `org_id`.

Le nom et l'adresse de connexion Super Admin restent inchangés. Aucun secret Super Admin n'est inclus dans le dépôt. Aucune nouvelle table SQL n'est nécessaire pour cette fonctionnalité ; conservez les données D1 existantes.

**Sécurité et mise en production :** l'inscription publique est activée. Avant une ouverture commerciale à grande échelle, ajouter CAPTCHA/Turnstile, validation de possession de l'e-mail et surveillance anti-abus. L'outil d'inscription limite actuellement les requêtes par IP et e-mail à l'aide de la table `login_attempts`.


## Navigation rapide (version optimisée)

Chaque entrée du menu possède une URL partageable, par exemple `/?page=members`, `/?page=savings`, `/?page=loans`, `/?page=repayments`, `/?page=reports`, `/?page=settings`, `/?page=superadmin`. Ce format de lien préserve le routage des assets Cloudflare Pages sans règle de réécriture supplémentaire.

La navigation utilise History API : aucune actualisation complète de la page lors d'un clic du menu. Une seule section D1 est chargée par demande. Les données de listes consultées sont conservées **uniquement en mémoire de l'onglet** pendant 20 secondes et sont invalidées à chaque écriture métier réussie. La réponse d'une navigation obsolète ne remplace pas l'écran plus récent. Un rafraîchissement navigateur rouvre le lien sélectionné après validation de session.

Les limites existantes sont conservées : le chargement de la page Super Admin effectue encore plusieurs appels D1 ; les listes serveur sont bornées mais ne disposent pas encore de pagination SQL complète. Le cache en mémoire n'est pas une preuve d'actualisation financière temps réel. Aucun changement de migration ni de secrets n'est nécessaire.


## Navigation directe et traduction française
Chaque section est accessible directement aux adresses `/summary`, `/members`, `/cycles`, `/meetings`, `/savings`, `/loans`, `/repayments`, `/solidarity`, `/distributions`, `/reports`, `/settings`, `/superadmin`. La navigation par clic conserve la page active sans recharger l'application. Les paramètres internes et les identifiants d'API restent en anglais pour préserver la compatibilité D1 et les anciennes données; seuls les libellés destinés aux utilisateurs sont traduits. Les anciennes URL `/?page=loans` sont acceptées à l'ouverture puis remplacées par `/loans`.

## Nouvelle version : calendrier des cycles et réunions

**Migration obligatoire sur la base existante** : exécuter une seule fois `migrations/0002_cycles_reunions.sql` dans la console D1 de la base liée à `avec_d1` **avant** de publier ce code. Ne pas réexécuter cette migration après réussite (les instructions ALTER TABLE ne sont pas répétables). Conserver `0001_init.sql` pour les nouvelles installations : exécuter ensuite `0002_cycles_reunions.sql`.

- Cycle : 9 ou 12 mois, début libre, fin calculée, réunion hebdomadaire ou tous les 14 jours et jour de la semaine, amende individuelle.
- Liste de cycles : durée, début, fin, fréquence, jour, amende, statut et bouton Clôturer.
- Clôture : réservée à l'administrateur, mot de passe vérifié dans le Worker, crédits soldés exigés ; cycle clôturé non modifiable.
- Réunions : dates prévues et saisie par membre des présences et paiements d'amendes.
- Épargnes : dates prévues et cotisations par membre, une saisie par réunion.
- Le gain de partage estimé additionne les **amendes encaissées**, jamais les impayés. Un registre des amendes non encaissées demeure dans les réunions.
- Les membres actuellement actifs de l'association apparaissent dans chaque réunion. L'inscription formelle à un cycle et les états historiques figés des participants ne sont pas encore gérés.

**Attention** : avant clôture, effectuer votre rapprochement manuel ; cette version exige les crédits soldés mais ne constitue pas un moteur comptable complet de liquidation et versement du partage.

## Mise à jour : pleine page et modification des cycles

- Toutes les vues utilisent désormais la largeur disponible de l'écran (sans limite de 1 350 px).
- Sur la page Cycles, la colonne Statut présente « Modifier » et « Clôturer » pour les cycles actifs aux administrateurs.
- Modification des champs du cycle (durée, dates, fréquence, valeur de part, amende) uniquement avant toute opération du cycle ; après les premiers mouvements, seul le nom peut changer. Les cycles clôturés restent verrouillés.
- Aucune migration SQL supplémentaire requise. Conserver les secrets et liaisons existants.


## Suppression définitive des cycles
Dans Cycles > Statut, l'administrateur dispose du bouton « Supprimer » sur les cycles actifs ou clôturés. Le serveur exige son mot de passe actuel, le nom exact du cycle et une confirmation explicite. D1 supprime atomiquement les mouvements associés (réunions, présences/amendes, cotisations, prêts/remboursements, solidarité, dépenses et distributions) puis le cycle, en conservant un journal d'audit avec le décompte des opérations effacées. Aucune migration SQL supplémentaire. **Sauvegarder D1 avant toute suppression.**


## Gestion des membres : modification / suppression
- Boutons « Modifier » et « Supprimer » dans la colonne Actions de `/members` (administrateur uniquement).
- Modification du nom, téléphone et localité sans changer l'identifiant du membre.
- Suppression confirmée par le mot de passe actuel de l'administrateur, contrôlé côté Worker.
- Si le membre a des écritures, désactivation (`active=0`) sans suppression des historiques ; sinon suppression définitive.
- Opérations tracées dans D1. Aucune migration SQL nouvelle.


## Correctif SQL — suppression des cycles
La requête de décompte des remboursements utilise maintenant trois paramètres liés (`org_id` externe, `org_id` de la sous-requête, `cycle_id`), contre deux auparavant. Ce correctif évite l'erreur D1 `Wrong number of parameter bindings for SQL query` lors de la suppression d'un cycle contenant ou non des remboursements. Aucune migration D1 n'est nécessaire et aucune donnée n'est effacée par le déploiement.


## Nouvelle correction — calendriers et fenêtres responsive
- Les dates futures sont verrouillées dans les calendriers de réunions et d'épargne, ainsi que côté serveur sur les écritures. La date courante est évaluée en UTC, identique à Africa/Abidjan.
- Fenêtres élargies sur ordinateur, tableau converti en fiches verticales sur mobile, sans défilement horizontal.
- Cotisations saisies en nombre entier de parts ; calcul automatique et sécurisé de montant = parts × valeur de la part du cycle.
- Aucune nouvelle migration SQL nécessaire.

## Rapport global par membre

La section `/reports` regroupe les réunions (présences et absences), les amendes payées et impayées, les parts et épargnes, les crédits, remboursements, restes à rembourser, solidarité versée, aides reçues et solde estimé. Choisir un cycle ou tous les cycles ; export CSV et impression. Le calcul se fait dans D1 par regroupements SQL, sans télécharger tous les mouvements. La table `meeting_attendance` créée par la migration `0002_cycles_reunions.sql` est nécessaire. Aucun changement de schéma complémentaire pour ce rapport.

Le solde estimé est une position indicative : épargne moins capital restant, intérêts restant et amendes impayées. Ce n'est pas le solde de caisse ni le montant du partage, et il ne tient pas compte des pertes éventuelles ou des décisions de compensation. Les contributions et aides de solidarité restent distinctes.
