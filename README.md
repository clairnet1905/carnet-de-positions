# Carnet de positions

Mini-application de suivi de trading pour actions US à l’achat (trend following, levier) :

- **Calculateur avant achat** : quantité maximale à 1 % de risque, plafonnée à 100 $ d’exposition, compatible avec la marge disponible, arrondie vers le bas.
- **Journal** : achats, ventes partielles, clôtures, frais, swaps, dividendes, plan respecté, captures du graphique.
- **Positions ouvertes** : latent, exposition, marge estimée, risque initial, perte possible au stop, recul depuis le cours.
- **Tableau de bord** : valeur nette, performance pondérée dans le temps (ou Modified Dietz signalé), drawdown, taux de réussite, profit factor, R moyen.

Aucun abonnement, aucune API payante, aucun identifiant de courtier. Tout est en dollars.

## 1. Mettre l’app en ligne (gratuit, une seule fois)

1. Créez un compte sur [github.com](https://github.com) si vous n’en avez pas.
2. Cliquez sur **+ › New repository**. Nom : `carnet-de-positions`. Laissez **Public** (seul le code est public, jamais vos données). Cliquez sur **Create repository**.
3. Sur la page du dépôt, cliquez sur **uploading an existing file**. Glissez **le contenu** de ce dossier (tous les fichiers : `index.html`, `manifest.webmanifest`, `sw.js`, les icônes `.png`, `README.md`, `LICENSE`), puis **Commit changes**.
4. Allez dans **Settings › Pages**. Sous *Branch*, choisissez `main` et `/ (root)`, puis **Save**.
5. Après une minute, l’adresse s’affiche : `https://VOTRE-NOM.github.io/carnet-de-positions/`.

## 2. Installer comme une app

- **Mac** : ouvrez l’adresse dans **Safari**, puis menu **Fichier › Ajouter au Dock**.
- **iPhone** : ouvrez l’adresse dans **Safari**, touchez **Partager › Sur l’écran d’accueil › Ajouter**.

L’app s’ouvre en plein écran, avec son icône, et fonctionne aussi sans réseau.

## 3. Activer la synchronisation Mac ↔ iPhone

Vos données sont stockées dans un **Gist secret** de votre compte GitHub (un petit fichier privé). Chaque appareil garde aussi sa propre copie.

1. Dans l’app : **Réglages › Synchronisation et sauvegarde › Activer la synchronisation**.
2. Suivez le lien pour créer un **jeton classic** avec **uniquement la case `gist`** cochée.
3. Collez le jeton (`ghp_…`) et touchez **Connecter**.
4. Faites la même chose sur l’autre appareil avec le même jeton. Gardez-le dans votre trousseau de mots de passe.

Fonctionnement :

- Chaque modification est envoyée quelques secondes plus tard ; l’app vérifie les changements de l’autre appareil à l’ouverture et chaque minute.
- Hors ligne, tout est enregistré sur l’appareil et envoyé au retour du réseau.
- Si les deux appareils ont été modifiés entre deux synchronisations, la version la plus récente est gardée et l’autre est **mise de côté**, restaurable dans les Réglages.
- GitHub garde l’historique de chaque version du Gist (bouton **Historique des versions**).

Sécurité : un Gist secret n’apparaît pas sur votre profil, mais quiconque obtient son adresse peut le lire. Ne partagez ni l’adresse du Gist ni le jeton. Le jeton ne donne accès qu’à vos gists, pas à vos dépôts ni à votre compte. Vous pouvez le révoquer à tout moment dans *GitHub › Settings › Developer settings › Personal access tokens*.

## 4. Récupérer vos données de la version claude.ai

Dans l’ancienne version : **Réglages › Exporter tout (JSON)**. Dans la nouvelle : **Réglages › Restaurer un JSON**. Le format est identique, captures comprises.

## 5. Mettre à jour l’app

Remplacez `index.html` (et les autres fichiers modifiés) dans le dépôt GitHub. Les appareils chargent la nouvelle version à la prochaine ouverture (parfois à la deuxième).

## Limites

- Le risque au stop est une estimation : un gap, le glissement ou les swaps peuvent augmenter la perte réelle. La marge affichée est indicative ; les règles du courtier prévalent. Aucun prix de liquidation n’est calculé.
- Les cours se saisissent à la main. La performance et le drawdown ne mesurent que ce qui se passe entre vos observations.
- Taille conseillée : quelques centaines de positions et quelques dizaines de captures.

## Licence

MIT : voir `LICENSE`.
