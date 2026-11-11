
# strava-home-runs

Turns GPX files (from Strava, Garmin or any other GPS source) into a 3D video of every run that started within a chosen radius of one point. It generalizes the script I used to animate five years of runs that started from my home.

<p align="center"><img src="docs/preview.gif" alt="Animation of 289 runs leaving the same point in Barcelona, each at its own pace, with a clock and a histogram of finish times" width="320"></p>

All runs leave the origin at the same moment and each one moves at its real pace, so the fast runs pull ahead and the long runs keep going after. Routes that you run often glow brighter, because overlapping runs add up like a heat map. A clock, a "still running" counter and a histogram of finish times fill in as runners get home. The runner marker can be a cut-out of your face or any image of your choice.

The map is built from free data: OpenStreetMap streets and AWS Terrain Tiles elevation. It runs in Blender, with no API keys.

## Requirements

- [pixi](https://pixi.sh). It installs Python, the Python packages and ffmpeg into a local environment.
- [Blender](https://www.blender.org/download/) 5.0 or newer (tested with 5.2), installed separately.

<details>
<summary>macOS (Homebrew)</summary>

```bash
brew install pixi
brew install --cask blender
```

</details>

<details>
<summary>Linux</summary>

```bash
curl -fsSL https://pixi.sh/install.sh | sh
sudo snap install blender --classic   # or the tarball from blender.org
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
winget install prefix-dev.pixi
winget install BlenderFoundation.Blender
```

</details>

Check that Blender is 5.0 or newer with `blender --version`.

The tool looks for Blender on your `PATH` and in `/Applications/Blender.app`. Use `--blender /path/to/blender` to point it somewhere else.

[uv](https://docs.astral.sh/uv/) also works (`uv run homeruns ...`), but then ffmpeg has to be on your `PATH`.

## Getting your GPX files

- **Strava:** Settings → My Account → Download or Delete Your Account → Request your archive. The `activities/` folder in the zip has `.gpx` files, and `.fit.gz` files for activities uploaded from a watch.
- **Garmin Connect:** export GPX from each activity's ⚙ menu. The bulk export gives FIT files.

The tool reads `.gpx` and `.tcx`, also gzipped. It doesn't read FIT files; convert them first, for example with `gpsbabel -i garmin_fit -f run.fit -o gpx -F run.gpx`.

## Usage

Run it from this folder. The first `pixi run` sets up the environment.

```bash
pixi run homeruns ~/Downloads/strava_export/activities --face me.png --place Lisbon --preview
```

`pixi run homeruns --help` lists all options.

`--preview` renders at half size and every second frame, which takes a few minutes. Check the result, then run the same command without `--preview` for the full 1440×2560 video.

Rendering takes about 5 s per frame on an Apple Silicon Mac, so the default 30 s run section (about 1,100 frames) takes around 1.5 hours.

The tool:

1. Reads every track and keeps the runs (`--sport`, default `run`; GPX files without a type are kept).
2. Finds home: the place where most runs start (or `--home lat,lon`). Keeps the runs that start within `--radius` metres (default 200).
3. Cleans the GPS:
   - Drops spikes faster than `--max-speed` (7 m/s).
   - Cuts a track where the signal is lost for good, for example in the metro.
   - Shortens long pauses.
4. Downloads elevation and streets for the area. These are cached in `--work` (default `.homeruns/`).
5. Builds and renders the scene in Blender, adds the overlay and encodes `home_runs.mp4` plus `home_runs_final.png`.

### Face marker

Pass a PNG or WebP of a face on a **transparent background** with `--face`. On macOS and iOS, "Copy Subject" or "Lift subject from background" in Photos makes one. The face is tinted orange by default; use `--tint 0` to keep its colours. Without `--face`, each runner is an orange dot.

### Options

| Option | Default | |
|---|---|---|
| `--title`, `--subtitle` | `HOME RUNS since <year>`, `<n> runs between <year> and <year>` | Text at the top |
| `--place` | | Added to the default subtitle |
| `--radius` | 200 | Metres from home a run must start within |
| `--home` | auto | `lat,lon` of home |
| `--since`, `--until` | | Date range, `YYYY-MM-DD` |
| `--sport` | `run` | Keep tracks whose type contains this; `any` keeps all |
| `--seconds` | 30 | Video seconds until the longest run finishes |
| `--size` | `1440x2560` | Output size; the layout is made for 9:16 |
| `--privacy-radius` | 0 | Cut this many metres around home from every track |
| `--no-sea` | | Don't treat land at sea level as sea (needed in places like the Netherlands) |
| `--line-strength` | auto | Brightness of a single route |
| `--crf` | 16 | Video quality; higher gives a smaller file |
| `--font-title`, `--font-text`, `--font-clock` | system fonts | TTF/OTF files |
| `--keep-frames` | | Keep the rendered PNGs in the work folder |

## Web version

`web/` holds a browser version that needs neither Blender nor ffmpeg: a [bun](https://bun.sh) script turns a Strava archive into a small `runs.json`, and a Vite page plays it on a MapLibre map (CARTO dark basemap, no API key) with deck.gl trails, then exports a 9:16 MP4 straight from the browser.

```bash
cd web
bun install
bun run ingest ~/Downloads/export_12345678  # the unzipped archive folder (with activities.csv)
bun run dev                                # open http://localhost:5173
```

Without a folder argument, `bun run ingest` uses the newest `export_*/` folder in the repository root (ignored by git), so you can unzip the archive there.

The ingest step reads `.fit`, `.gpx` and `.tcx` files, also gzipped, and takes the activity type and name from `activities.csv`. Without an `activities.csv` it scans the folder and uses the sport stored in each file. It cleans the tracks the same way as the Python tool and keeps every run with GPS, wherever it starts. It then finds your homes: the place where most runs start, then the next one among the remaining runs (leaving out starts within twice the radius of a home already found), and so on while a place has at least `--min-home-runs` (10) starts within `--radius` (200 m), so the homes include other places you lived. The page lists a place closer than `--home-spacing` (1000 m) to a larger one as a "nearby start spot" of that home instead. `--home lat,lon` adds a home of your own as the first one. `--since`, `--until`, `--sport`, `--max-speed` and `--privacy-radius` work as in the Python tool (`bun run ingest --help` lists them). It writes `web/data/runs.json`, which is gitignored because it holds your GPS tracks. The dev and preview servers serve it to the page; `bun run build` leaves it out of `web/dist/`.

In the page, **Home** lists those places with their run counts and years. Pick one, give it a name (it is added to the subtitle, like `--place`), or choose **Pick on map** and click where the runs start; the page shows how many runs start within the radius as you move the mouse. Changing home filters the runs by their distance to it, resets the dates to that home's years, and re-centres the camera; the title follows ("HOME RUNS since" the first year at that home). Names, each home's radius, picked homes and the last home are remembered in this browser (picked homes and the selection per data file). You can also play, pause, scrub and replay, change the speed and the video length, filter by date and start radius, hide the ends of the runs near home, and set the trail strength and titles. **Export MP4** renders the video frame by frame at 720×1280, 1080×1920 or 1440×2560 with WebCodecs, so frames are never dropped, however slow the machine. Each frame waits until its map tiles have loaded and asks once more for any that failed. If tiles still fail or never arrive, the export finishes with a warning that lists the frames with gaps in the basemap. If rendering stalls (3 frames in a row over 60 s each, or far slower than the first frames suggested), the export stops and says so. "First … s" exports only the start, which is a quick test. Keep the tab visible while it exports: browsers pause background tabs, so the export stops if the tab is hidden. A recent Chrome or Edge works best. Browsers without WebCodecs fall back to MediaRecorder, which records in real time.

The page loads map tiles from CARTO; everything else stays on your machine. `bun run dev` and `bun run preview` only listen on localhost. Don't start them with `--host`: that serves your `runs.json`, and so your tracks, to everyone on the local network.

Other commands, all run in `web/`: `bun test`, `bun run typecheck` and `bun run build` (static files go to `web/dist/`, without your data).

On a phone the page keeps the 9:16 map on screen. In portrait, the controls are a bottom sheet: closed, it shows play, replay and the scrubber; **Settings** opens the rest. In landscape, they are a column beside the map. All controls are at least 44 px tall. **Pick on map** works by touch: drag to pan and pinch to zoom. The first tap shows how many runs start there; tap the spot again or press **Use this spot** to use it.

### Hosting it

`bun run build:site` builds a self-contained static folder, `web/site/` (gitignored):

- `index.html`: a landing page with a pre-rendered video and an **Open the live map** button.
- `video.mp4` and `poster.jpg`: an H.264 export of the first home at 1080×1920 and 2.5 Mbit/s, with `moov` before `mdat` so phones start playing at once. It is rendered by headless Chrome (set `CHROME=` if it isn't found).
- `map/`: the interactive page.
- `map/data/runs.json` plus `.gz` and `.br` copies: **your full data file**.
- `robots.txt`: disallows everything.

The options are `--reuse-video` (keep the existing video and poster), `--size`, `--bitrate` and `--seconds`. Every page has `noindex`. The folder contains every track and every home, so only serve it behind a password, never in public, and never commit it.

## Privacy

The video opens on your location of choice and every run leaves from it, which might show where you live.

`--privacy-radius 300` cuts the first and last 300 m of every track. It also drops the shared start point, so each runner appears at the edge of the circle. Strava's privacy zones work the same way. With many runs though, the centre of the circle can still be estimated, so leave out the video if your address must stay private.

The web version's data file lists every home it found, so it shows every place you have run from often, which usually means every place you have lived. It stays on your computer; don't share it, and don't start the servers with `--host`.

In the page, "Hide the ends within … of home" trims every run's start and end near the chosen home before it is drawn, so the video works the same way as `--privacy-radius`. With `--privacy-radius R` at ingest, every run loses the points at its start that lie within R of where it began, and the points at its end within R of where it ended (like Strava's "hide start and end"); the start and end are also trimmed while they are within R of any home. The homes are stored rounded to about 1 km, and the page's default start radius is then a fixed 2 km, so it says nothing about R. Picking and filtering homes still work, but only approximately (the page says so). Neither hides home well: the trimmed tracks begin and end on a circle around it, and with hundreds of runs the centre of that circle can be found to within about a metre. Only the start and end are trimmed, so a run that passes near home in the middle still shows it. If your address must stay private, don't share the video or `runs.json`.

## How it works

- **Timing:** the clock starts slowly and speeds up exponentially, so the busy first minutes are readable and the long runs don't drag.
- **Camera:** at every frame, it finds the closest position at which everything drawn so far fits between the title and the clock.
- **Heat:** routes render additively in a separate view layer, and the compositor maps the sum onto a heat colour ramp.
- **Marker:** each face is a camera-facing card at the head of its route.

The code is in `homeruns/`:

| File | Role |
|---|---|
| `tracks.py` | Reads GPX/TCX, finds home, cleans GPS |
| `basemap.py` | Downloads elevation and streets |
| `prepare.py` | Builds the street texture and route points |
| `scene.py` | Builds the scene in Blender |
| `render_setup.py` | Render settings |
| `overlay.py` | Text, histogram and encoding |
| `timewarp.py` | Clock curve |

## Credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). The video carries this credit.
- Elevation from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM, GMTED, NED and other sources).
- Strava is a trademark of Strava, Inc. and Garmin is a trademark of Garmin Ltd. This project is not affiliated with or endorsed by either.

## License

MIT
