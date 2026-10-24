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
