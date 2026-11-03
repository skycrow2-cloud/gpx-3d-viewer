# Aide en ligne GPX 3D

- `index.html` — la page d'aide (lien « Aide illustrée » dans la fenêtre « i » de l'outil, ou `help/index.html`).
- `demo.gpx` — trace d'exemple fictive, utilisée pour les captures et téléchargeable depuis l'aide.
- `capture.js` — génère `img/*.png` et `video/*.mp4` à partir de l'outil réel.

## Générer les captures et vidéos

Depuis la racine du dépôt (Internet requis pour les tuiles de carte) :

    npm i playwright && npx playwright install chromium
    node help/capture.js          # tout (ou : img / video)

`ffmpeg` convertit les vidéos en .mp4 (sinon .webm). Tant qu'un média manque, l'aide affiche un cadre pointillé à sa place.
Relancer le script après toute modification de l'interface garde l'aide à jour.
