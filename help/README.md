# Aide illustrée de GPX 3D

- `index.html` — la page d'aide, bilingue FR / EN (bouton **i** de l'outil → « Aide illustrée », ou `help/index.html`).
- `demo.gpx` — trace d'exemple fictive (boucle de 6,5 km) : elle illustre l'aide et se télécharge depuis la page.
- `demo-guidage.gpx` — sentier d'exemple court (0,86 km) avec des virages francs et un demi-tour : la boucle de `demo.gpx` est trop lisse (aucun changement de cap ≥ 45°) pour illustrer le guidage.
- `capture.js` — génère `img/*.png|jpg` et `video/*.mp4` en pilotant l'outil réel.
- `img/`, `video/` — les médias, déposés par l'action GitHub. Tant qu'un média manque, l'aide affiche un cadre pointillé à sa place.

## Régénérer les médias

Les captures ont besoin d'Internet (tuiles de carte, MapLibre par CDN, Nominatim et Open-Meteo).
Le plus simple est de laisser faire l'action **« Aide — captures et vidéos »** : onglet *Actions* → *Run workflow*
(`all`, `img` ou `video`). Elle exécute le script sur un runner, puis commite `help/img` et `help/video`.
Elle part aussi d'elle-même quand `index.html`, `help/capture.js` ou `help/demo.gpx` changent.

L'action part sur `index.html`, `help/capture.js` et `help/demo.gpx` ; après une modification de
`help/demo-guidage.gpx`, relancez-la à la main.

À la main, depuis la racine du dépôt :

    npm i playwright && npx playwright install --with-deps chromium
    node help/capture.js            # ou : img / video

`ffmpeg` convertit les vidéos en `.mp4` ; sans lui elles restent en `.webm`, que la page accepte aussi.
Une capture qui échoue (service injoignable, élément masqué) n'interrompt pas les autres : le script
liste les médias manquants à la fin.

Variables d'environnement utiles à la mise au point hors ligne : `CHROME_PATH` (Chrome du système),
`MAPLIBRE_JS` et `PROJ4_JS` (copies locales des bibliothèques servies à la place du CDN).

## Ce que contient chaque média

| Fichier | Contenu |
|---|---|
| `00-accueil.jpg` | écran de départ, sans trace |
| `01-interface.jpg` | vue d'ensemble, trace chargée |
| `02-charger.png` | zone de chargement du panneau |
| `03-stats.png`, `04-profil.png` | statistiques, profil altitude + vitesse |
| `05-lecture.png` | commandes de lecture et cases de caméra |
| `06-depart-arrivee.jpg` | repères vert (départ) et rouge (arrivée) |
| `07-vue-generale.jpg`, `08-suivi.jpg` | lecture en vue générale, puis en suivi 1:500 avec cap |
| `09-fonds.png`, `10-legende.png` | menu des fonds de carte, légende |
| `11-options.png`, `12-theme-clair.jpg` | options, thème clair |
| `13-menu-clic-droit.png`, `13-points.jpg` | menu du clic droit, points affichés |
| `14-coordonnees.png`, `15-meteo.png` | boîte de coordonnées, barre lieu + météo |
| `16-assiette.jpg` | vue inclinée à 55° |
| `17-guidage-panneau.png`, `17-guidage-etat.png` | section guidage : bouton, case, ligne d'état |
| `18-guidage-virage.jpg`, `19-guidage-hors-trace.jpg`, `20-guidage-depart.jpg` | pastilles du guidage et fenêtre « départ éloigné » |
| `21-osm.png`, `22-aide-rapide.png` | panneau OpenStreetMap, fenêtre d'aide rapide |
| `23-telephone.jpg`, `24-outils.png` | rendu téléphone, menu Outils |
| `video/01-demarrer.<lang>` | charger un GPX puis lancer la lecture |
| `video/02-suivi-cap.<lang>` | suivi rapproché avec orientation selon le cap |
| `video/03-fonds.<lang>` | changer de fond, régler l'opacité, incliner la vue |
| `video/04-guidage.<lang>` | guidage GPS simulé : virage, sortie de trace, retour |
| `video/05-profil.<lang>` | déplacer la position en glissant sur le profil |

## Voix des vidéos

Chaque vidéo existe en français et en anglais (`04-guidage.fr.mp4`, `04-guidage.en.mp4`), avec un
fichier de sous-titres `.vtt` tiré du même texte. Les phrases sont dans la table `NARRATION` de
`capture.js` : chacune est accrochée à un **repère** (`mark('virage')`) posé par le scénario au moment
exact de l'action, donc la voix reste calée même si le runner est lent. Le script prévient quand une
phrase déborde sur la suivante — c'est le signe qu'il faut allonger l'attente du scénario.

La synthèse est faite par **Piper** (voix `fr_FR-siwis-medium` et `en_GB-alba-medium`), installé par
l'action ; sans lui, `espeak-ng` prend le relais, et sans aucun des deux les vidéos restent muettes.
Pour vérifier le montage sans navigateur : `TTS_FAKE=1 node help/capture.js audio 04-guidage`
(un bip remplace la voix, les fichiers `*-essai.*` sont écrits dans `help/video`).

Le guidage est capturé avec une **géolocalisation simulée** (Playwright) qui suit `demo-guidage.gpx` :
aucun déplacement réel n'est nécessaire. Le temps de chargement est coupé au montage des vidéos.

Les captures utilisent **CartoWeb.be** comme fond (variable `CAPTURE_BASEMAP`) : OpenTopoMap, le fond par
défaut de l'outil, renvoie des tuiles filigranées aux adresses de centre de données comme celles des runners.
