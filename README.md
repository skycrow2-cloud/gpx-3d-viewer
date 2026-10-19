# GPX 3D — visualiseur de trace

Visualiseur de traces GPX en 3D, dans un seul fichier HTML autonome : relief, photo aérienne, profil altitude/vitesse et lecture animée du parcours avec suivi caméra.

**Démo :** https://skycrow2-cloud.github.io/gpx-3d-viewer/

## Fonctionnalités

- Terrain 3D (MapLibre GL, exagération du relief 1,6)
- Fond photo aérienne Esri ou plan randonnée OpenTopoMap
- Profil altitude / vitesse (et extensions GPX : fréquence cardiaque, cadence, température)
- Lecture animée avec suivi caméra (échelle 1:500), orientation selon le cap, vue générale
- Panneau latéral redimensionnable, interface FR / EN
- Envoi de la trace vers OpenStreetMap (OAuth 2, facultatif)

## Utilisation

Ouvrir `index.html` dans un navigateur récent, puis charger ou glisser-déposer un fichier `.gpx`. Aucune installation ni clé d'API n'est nécessaire.

La connexion OpenStreetMap exige une page servie en `https://` (GitHub Pages convient) ou sur `http://localhost` ; elle ne fonctionne pas en ouvrant le fichier en local (`file://`). Lors de la déclaration de l'application OAuth sur openstreetmap.org, utiliser comme URI de redirection l'adresse exacte de la page (par ex. `https://skycrow2-cloud.github.io/gpx-3d-viewer/`).

### Publier avec GitHub Pages

Settings → Pages → *Deploy from a branch* → branche `main`, dossier `/ (root)`.

## Confidentialité

Le fichier GPX est lu localement dans le navigateur et n'est envoyé à aucun serveur, sauf envoi volontaire vers OpenStreetMap. Pour afficher le nom du lieu et la météo, la position courante est transmise à Nominatim (OpenStreetMap) et Open-Meteo.

## Sources de données

Imagerie © Esri, Maxar, Earthstar Geographics · Relief © AWS Open Data Terrain Tiles / Mapzen · Fond de carte © OpenStreetMap contributors, SRTM · Style © OpenTopoMap (CC-BY-SA) · Géocodage Nominatim · Météo Open-Meteo.

Bibliothèques : [MapLibre GL JS](https://maplibre.org/) 5.12, [proj4js](http://proj4js.org/) 2.9.2 (CDN cdnjs).

## Auteur

© A.Legat — v1.2.2
