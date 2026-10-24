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
