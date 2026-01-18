// === KONFIGURATION: SECRETS VIA GITHUB ACTIONS ===
// Diese Werte werden beim Deploy von GitHub Actions injiziert
const CLIENT_ID = "039603357f2c4b77ba202ab988a57516"; // aus dem Spotify Developer Dashboard
const REDIRECT_URI = "https://lukas106410.github.io/MusicQuiz/
"; // muss im Dashboard als Redirect URI eingetragen sein

// benötigte Scopes: Streaming + Playlist + Playback
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-read-collaborative"
].join(" ");

// Storage-Keys
const LS_CODE_VERIFIER = "spotify_code_verifier";
const LS_ACCESS_TOKEN = "spotify_access_token";
const LS_TOKEN_EXPIRES_AT = "spotify_token_expires_at";

// === STATE ===
let accessToken = null;
let playlistTracks = [];
let currentIndex = -1;
let mode = "noob";
let countdownInterval = null;
let remainingSeconds = 0;

let currentCategory = null;

let userPlaylists = [];
let playlistsLoaded = false;
let isFetchingPlaylists = false;

// Kategorien pro Modus
const CATEGORIES = {
  noob: [
    { id: "decade", label: "Jahrzehnt raten" },
    { id: "feature", label: "Hat der Song ein Feature (≥ 2 Artists)?" },
    { id: "year-plus-minus-4", label: "Erscheinungsjahr (±4 Jahre)" },
    { id: "before-after-2000", label: "Vor oder nach 2000?" },
    { id: "year-plus-minus-2", label: "Erscheinungsjahr (±2 Jahre)" }
  ],
  pro: [
    { id: "artist", label: "Künstler / Interpret raten" },
    { id: "title", label: "Songtitel raten" },
    { id: "year-plus-minus-4", label: "Erscheinungsjahr (±4 Jahre)" },
    { id: "year-plus-minus-2", label: "Erscheinungsjahr (±2 Jahre)" },
    { id: "album", label: "Album raten" }
  ]
};

// === DOM HELPERS ===
const $ = (id) => document.getElementById(id);

const playlistInput = $("playlistInput");
const playlistInfo = $("playlistInfo");
const playlistSuggestions = $("playlistSuggestions");

const btnLoadPlaylist = $("btnLoadPlaylist");
const btnInitPlayer = $("btnInitPlayer");
const btnStartRound = $("btnStartRound");
const btnReveal = $("btnReveal");
const btnStop = $("btnStop");

const btnLogin = $("btnLogin");
const btnLogout = $("btnLogout");
const loginInfo = $("loginInfo");

const countdownDisplay = $("countdownDisplay");
const questionsList = $("questionsList");

const categoryBanner = $("categoryBanner");
const categoryValue = $("categoryValue");

const roundInfo = $("roundInfo");
const modeLabel = $("modeLabel");
const playerStatusDot = $("playerStatusDot");
const playerStatusText = $("playerStatusText");
const trackIndexLabel = $("trackIndexLabel");
const solutionCard = $("solutionCard");

const solutionTitle = $("solutionTitle");
const solutionArtist = $("solutionArtist");
const solutionAlbum = $("solutionAlbum");
const solutionYear = $("solutionYear");
const solutionDecade = $("solutionDecade");
const solutionSoloGroup = $("solutionSoloGroup");

const durationInput = $("durationInput");

// === UTILS ===
function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
}

// === PKCE HELFER ===
function generateRandomString(length) {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return values.reduce((acc, x) => acc + possible[x % possible.length], "");
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return await crypto.subtle.digest("SHA-256", data);
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createCodeChallenge(codeVerifier) {
  const digest = await sha256(codeVerifier);
  return base64UrlEncode(digest);
}

function saveToken(token, expiresIn) {
  accessToken = token;
  const expiresAt = Date.now() + (expiresIn || 3600) * 1000;
  localStorage.setItem(LS_ACCESS_TOKEN, accessToken);
  localStorage.setItem(LS_TOKEN_EXPIRES_AT, String(expiresAt));
}

function loadTokenFromStorage() {
  const stored = localStorage.getItem(LS_ACCESS_TOKEN);
  const expiresAt = parseInt(localStorage.getItem(LS_TOKEN_EXPIRES_AT) || "0", 10);
  if (!stored || !expiresAt) return null;
  if (Date.now() > expiresAt) {
    // abgelaufen
    localStorage.removeItem(LS_ACCESS_TOKEN);
    localStorage.removeItem(LS_TOKEN_EXPIRES_AT);
    return null;
  }
  accessToken = stored;
  return stored;
}

function clearAuth() {
  accessToken = null;
  localStorage.removeItem(LS_ACCESS_TOKEN);
  localStorage.removeItem(LS_TOKEN_EXPIRES_AT);
  localStorage.removeItem(LS_CODE_VERIFIER);
}

// === SPOTIFY LOGIN (PKCE) ===
async function startLogin() {
  clearAuth(); // frischer Start

  const codeVerifier = generateRandomString(64);
  localStorage.setItem(LS_CODE_VERIFIER, codeVerifier);
  const codeChallenge = await createCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: codeChallenge
  });

  const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;
  console.log("Spotify authorize URL:", authUrl);
  window.location.href = authUrl;
}

async function handleRedirectCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    console.error("Spotify Error:", error);
    loginInfo.textContent = "Login abgebrochen / Fehler.";
    return;
  }

  if (!code) {
    // kein Code -> versuchen aus Storage zu laden
    const token = loadTokenFromStorage();
    if (token) {
      accessToken = token;
      updateLoginInfo();
    }
    return;
  }

  // Code vorhanden → in Token tauschen
  const codeVerifier = localStorage.getItem(LS_CODE_VERIFIER);
  if (!codeVerifier) {
    console.error("Kein Code Verifier gefunden.");
    return;
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier
    });

    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!res.ok) {
      console.error("Token-Request fehlgeschlagen", res.status);
      loginInfo.textContent = "Token-Request fehlgeschlagen.";
      return;
    }

    const data = await res.json();
    saveToken(data.access_token, data.expires_in);

    // Code aus der URL entfernen, damit Reloads sauber sind
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, document.title, url.toString());

    updateLoginInfo();
  } catch (err) {
    console.error("Token-Fehler", err);
  }
}

async function updateLoginInfo() {
  if (!accessToken) {
    loginInfo.textContent = "Nicht eingeloggt";
    setPlayerStatus(false, "Player nicht verbunden");
    return;
  }
  try {
    const res = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      loginInfo.textContent = "Eingeloggt (Fehler beim Lesen des Profils)";
      return;
    }
    const me = await res.json();
    const name = me.display_name || me.id || "Spotify User";
    loginInfo.textContent = `Eingeloggt als ${name}`;
    setPlayerStatus(true, "Steuert aktives Spotify-Gerät");

    // Playlists optional vorab laden
    ensurePlaylistsLoaded();
  } catch {
    loginInfo.textContent = "Eingeloggt (Profil konnte nicht geladen werden)";
  }
}

// === MODE UI ===
function renderQuestions() {
  if (!questionsList) return;

  if (mode === "noob") {
    questionsList.innerHTML = `
      <li>Erscheinungsjahrzehnt?</li>
      <li>Hat der Song ein Feature? (≥ 2 Artists)</li>
      <li>Erscheinungsjahr (±4 Jahre)?</li>
      <li>Vor oder nach 2000?</li>
      <li>Erscheinungsjahr (±2 Jahre)?</li>
    `;
  } else {
    questionsList.innerHTML = `
      <li>Künstler/Interpret?</li>
      <li>Songtitel?</li>
      <li>Erscheinungsjahr (±4 Jahre)?</li>
      <li>Erscheinungsjahr (±2 Jahre)?</li>
      <li>Album?</li>
    `;
  }
  modeLabel.textContent = mode === "noob" ? "Noob" : "Pro";
}

function setupModeToggle() {
  const toggle = $("modeToggle");
  if (!toggle) return;
  toggle.addEventListener("click", (e) => {
    const option = e.target.closest(".mode-option");
    if (!option) return;
    const newMode = option.dataset.mode;
    if (!newMode || newMode === mode) return;
    mode = newMode;
    Array.from(toggle.querySelectorAll(".mode-option")).forEach((el) =>
      el.classList.toggle("active", el.dataset.mode === mode)
    );
    renderQuestions();
  });
  renderQuestions();
}

// === KATEGORIE ===
function resetCategory() {
  currentCategory = null;
  if (categoryValue) categoryValue.textContent = "–";
  if (categoryBanner) categoryBanner.classList.remove("visible");
}

function chooseCategoryForCurrentMode() {
  const list = CATEGORIES[mode] || [];
  if (!list.length) {
    resetCategory();
    return;
  }
  const randomIndex = Math.floor(Math.random() * list.length);
  currentCategory = list[randomIndex];
  if (categoryValue) categoryValue.textContent = currentCategory.label;
  if (categoryBanner) categoryBanner.classList.add("visible");
}

// === COUNTDOWN ===
function updateCountdownDisplay() {
  let value = remainingSeconds;
  if (value < 0) value = 0;
  countdownDisplay.textContent = value.toString().padStart(2, "0");
  if (value <= 5 && value > 0) {
    countdownDisplay.classList.add("critical");
  } else {
    countdownDisplay.classList.remove("critical");
  }
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function startCountdown(seconds) {
  stopCountdown();
  remainingSeconds = seconds;
  updateCountdownDisplay();
  if (seconds <= 0) return;
  countdownInterval = setInterval(() => {
    remainingSeconds -= 1;
    updateCountdownDisplay();
    if (remainingSeconds <= 0) {
      stopCountdown();
      pausePlayback(); // Timer ist abgelaufen -> Musik stoppen
    }
  }, 1000);
}

// === SPOTIFY HELFER ===
function parsePlaylistId(url) {
  if (!url) return null;
  try {
    const parts = url.split("/playlist/");
    if (parts.length < 2) return null;
    let rest = parts[1];
    const qIndex = rest.indexOf("?");
    if (qIndex !== -1) {
      rest = rest.slice(0, qIndex);
    }
    return rest || null;
  } catch {
    return null;
  }
}

async function fetchAllPlaylistTracks(playlistId) {
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error("Spotify API Error:", res.status, errorText);
      alert("Spotify-Fehler " + res.status + ":\n" + errorText);
      throw new Error("Fehler beim Laden der Playlist: " + res.status);
    }
    const data = await res.json();
    for (const item of data.items || []) {
      if (item && item.track && !item.is_local) {
        tracks.push(item.track);
      }
    }
    url = data.next;
  }
  return tracks;
}

async function fetchAllUserPlaylists() {
  const playlists = [];
  let url = "https://api.spotify.com/v1/me/playlists?limit=50";
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("Fehler beim Laden der Playlists:", res.status, text);
      throw new Error("Fehler beim Laden der Playlists: " + res.status);
    }
    const data = await res.json();
    for (const pl of data.items || []) {
      if (pl && pl.id) {
        playlists.push(pl);
      }
    }
    url = data.next;
  }
  return playlists;
}

async function ensurePlaylistsLoaded() {
  if (!accessToken || playlistsLoaded || isFetchingPlaylists) return;
  isFetchingPlaylists = true;
  try {
    userPlaylists = await fetchAllUserPlaylists();
    playlistsLoaded = true;
  } catch (e) {
    console.error(e);
  } finally {
    isFetchingPlaylists = false;
  }
}

function renderPlaylistSuggestions(filterText = "") {
  if (!playlistSuggestions) return;
  playlistSuggestions.innerHTML = "";

  if (!accessToken) {
    playlistSuggestions.innerHTML = `<div class="playlist-suggestion-item disabled">Bitte zuerst einloggen</div>`;
    playlistSuggestions.classList.add("visible");
    return;
  }

  if (!userPlaylists.length) {
    if (playlistsLoaded) {
      playlistSuggestions.innerHTML = `<div class="playlist-suggestion-item disabled">Keine Playlists gefunden</div>`;
      playlistSuggestions.classList.add("visible");
    }
    return;
  }

  const q = filterText.trim().toLowerCase();
  let list = userPlaylists;
  if (q) {
    list = userPlaylists.filter((pl) => {
      const name = (pl.name || "").toLowerCase();
      const owner = (pl.owner && pl.owner.display_name || "").toLowerCase();
      return name.includes(q) || owner.includes(q);
    });
  }

  if (!list.length) {
    playlistSuggestions.innerHTML = `<div class="playlist-suggestion-item disabled">Keine Treffer für deine Eingabe</div>`;
    playlistSuggestions.classList.add("visible");
    return;
  }

  const maxToShow = 8;
  list.slice(0, maxToShow).forEach((pl) => {
    const div = document.createElement("div");
    div.className = "playlist-suggestion-item";
    const owner = (pl.owner && pl.owner.display_name) || "Unbekannt";
    const tracks = pl.tracks && typeof pl.tracks.total === "number" ? pl.tracks.total : "";
    div.innerHTML = `
      <div class="psi-name">${escapeHtml(pl.name)}</div>
      <div class="psi-meta">${escapeHtml(owner)} · ${tracks} Titel</div>
    `;
    div.addEventListener("click", () => {
      const url = (pl.external_urls && pl.external_urls.spotify) || `https://open.spotify.com/playlist/${pl.id}`;
      playlistInput.value = url;
      hidePlaylistSuggestions();
    });
    playlistSuggestions.appendChild(div);
  });

  playlistSuggestions.classList.add("visible");
}

function hidePlaylistSuggestions() {
  if (playlistSuggestions) playlistSuggestions.classList.remove("visible");
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// === "PLAYER" (Remote für aktives Gerät) ===
function setPlayerStatus(ok, text) {
  playerStatusDot.classList.toggle("ok", ok);
  playerStatusText.textContent = text;
}

/**
 * Startet die Wiedergabe auf dem AKTIVEN Spotify-Gerät des Users.
 * Wichtig: User muss irgendwo (Handy/Desktop) Spotify geöffnet und
 * einmal einen Song gestartet haben, sonst liefert die API 404.
 */
async function startPlayback(track) {
  if (!track || !track.uri) return;
  if (!accessToken) {
    alert("Bitte zuerst mit Spotify einloggen.");
    return;
  }

  try {
    const res = await fetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uris: [track.uri],
        position_ms: 0,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("Fehler beim Starten des Playbacks", res.status, text);

      if (res.status === 404) {
        alert(
          "Spotify findet kein aktives Wiedergabegerät.\n\n" +
          "So klappt's:\n" +
          "1. Öffne Spotify auf einem Gerät (Handy/Desktop/Speaker)\n" +
          "2. Spiele irgendeinen Song einmal kurz ab und pausiere ihn wieder\n" +
          "3. Klicke dann hier nochmal auf 'Nächsten Song starten'."
        );
      } else if (res.status === 403) {
        alert(
          "Spotify erlaubt das Abspielen nicht (403).\n" +
          "Stelle sicher, dass dein Account Premium ist und du beim Login 'streaming' und 'user-modify-playback-state' erlaubt hast."
        );
      } else if (res.status === 401) {
        alert(
          "Dein Spotify-Login ist abgelaufen (401).\n" +
          "Bitte melde dich neu an."
        );
      } else {
        alert("Fehler beim Starten des Playbacks: " + res.status);
      }
    }
  } catch (err) {
    console.error("Playback-Fehler", err);
    alert("Netzwerkfehler beim Starten des Playbacks (Details in der Konsole).");
  }
}

async function pausePlayback() {
  if (!accessToken) return;
  try {
    await fetch("https://api.spotify.com/v1/me/player/pause", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (err) {
    console.error("Pause-Fehler", err);
  }
}

// === RUNDENSTEUERUNG ===
function resetSolutionView() {
  solutionCard.classList.add("solution-hidden");
  solutionTitle.textContent = "---";
  solutionArtist.textContent = "---";
  solutionAlbum.textContent = "---";
  solutionYear.textContent = "---";
  solutionDecade.textContent = "---";
  solutionSoloGroup.textContent = "---";
  trackIndexLabel.textContent = "–";
}

function fillSolution(track) {
  if (!track) return;
  const artists = (track.artists || []).map((a) => a.name).join(", ");
  const title = track.name || "Unbekannt";
  const albumName = (track.album && track.album.name) || "–";
  const releaseRaw = (track.album && track.album.release_date) || "";
  const year = releaseRaw ? releaseRaw.slice(0, 4) : "–";
  const yearNum = parseInt(year, 10);
  const decade = isNaN(yearNum) ? "–" : `${Math.floor(yearNum / 10) * 10}er`;
  const hasFeature =
    (track.artists && track.artists.length > 1)
      ? "Ja (≥ 2 Artists)"
      : "Nein (nur 1 Artist)";

  solutionTitle.textContent = title;
  solutionArtist.textContent = artists || "–";
  solutionAlbum.textContent = albumName;
  solutionYear.textContent = year;
  solutionDecade.textContent = decade;
  solutionSoloGroup.textContent = hasFeature;
  solutionCard.classList.remove("solution-hidden");
  trackIndexLabel.textContent = `${currentIndex + 1} / ${playlistTracks.length}`;
}

function updateRoundInfo() {
  if (playlistTracks.length === 0 || currentIndex < 0) {
    roundInfo.textContent = "–";
  } else {
    roundInfo.textContent = `${currentIndex + 1} / ${playlistTracks.length}`;
  }
}

async function startNextRound() {
  if (!accessToken) {
    alert("Bitte zuerst mit Spotify einloggen.");
    return;
  }
  if (!playlistTracks.length) {
    alert("Bitte zuerst eine Playlist laden.");
    return;
  }

  // Nächsten Index wählen
  currentIndex += 1;
  if (currentIndex >= playlistTracks.length) {
    // Wenn alle durch sind: neu mischen und von vorne
    shuffle(playlistTracks);
    currentIndex = 0;
  }
  const track = playlistTracks[currentIndex];

  updateRoundInfo();
  resetSolutionView();
  resetCategory();
  chooseCategoryForCurrentMode();

  // Countdown vorbereiten
  let seconds = parseInt(durationInput.value, 10);
  if (isNaN(seconds) || seconds <= 0) seconds = 30;
  startCountdown(seconds);

  // Playback starten
  startPlayback(track);
}

function revealCurrentSolution() {
  if (currentIndex < 0 || currentIndex >= playlistTracks.length) {
    alert("Noch keine Runde gestartet.");
    return;
  }
  pausePlayback();
  stopCountdown();
  fillSolution(playlistTracks[currentIndex]);
}

async function stopAll() {
  stopCountdown();
  await pausePlayback();
}

// === UI EVENTS ===
btnLoadPlaylist.addEventListener("click", async () => {
  if (!accessToken) {
    alert("Bitte zuerst mit Spotify einloggen.");
    return;
  }
  const url = playlistInput.value.trim();
  const id = parsePlaylistId(url);
  if (!id) {
    alert("Konnte Playlist-ID nicht aus der URL lesen.");
    return;
  }
  playlistInfo.textContent = "Lade Playlist...";
  try {
    const tracks = await fetchAllPlaylistTracks(id);
    if (!tracks.length) {
      playlistInfo.textContent = "Keine Tracks gefunden.";
      return;
    }
    playlistTracks = shuffle(tracks);
    currentIndex = -1;
    updateRoundInfo();
    playlistInfo.textContent = `Tracks geladen: ${playlistTracks.length}`;
    resetSolutionView();
    resetCategory();
  } catch (err) {
    console.error(err);
    playlistInfo.textContent = "Fehler beim Laden der Playlist (Details in Konsole).";
  }
});

// "Player verbinden" zeigt jetzt nur noch eine Hilfe an
btnInitPlayer.addEventListener("click", () => {
  alert(
    "Dieses Musik Quiz steuert dein aktives Spotify-Gerät.\n\n" +
    "So richtest du es ein:\n" +
    "1. Öffne Spotify auf einem Gerät (Handy / Desktop / Speaker)\n" +
    "2. Starte irgendeinen Song und pausiere ihn wieder\n" +
    "3. Wähle hier eine Playlist und klicke auf 'Nächsten Song starten'."
  );
});

btnStartRound.addEventListener("click", () => {
  startNextRound();
});

btnReveal.addEventListener("click", () => {
  revealCurrentSolution();
});

btnStop.addEventListener("click", () => {
  stopAll();
});

btnLogin.addEventListener("click", () => {
  if (!CLIENT_ID || CLIENT_ID === "DEINE_CLIENT_ID_HIER") {
    alert("Bitte zuerst in app.js CLIENT_ID und Redirect URI im Spotify Dashboard korrekt setzen.");
    return;
  }
  startLogin();
});

btnLogout.addEventListener("click", () => {
  clearAuth();
  loginInfo.textContent = "Nicht eingeloggt";
  setPlayerStatus(false, "Player nicht verbunden");
});

// Playlist-Dropdown Events
if (playlistInput) {
  playlistInput.addEventListener("focus", async () => {
    if (!accessToken) {
      renderPlaylistSuggestions("");
      return;
    }
    await ensurePlaylistsLoaded();
    renderPlaylistSuggestions(playlistInput.value);
  });

  playlistInput.addEventListener("input", () => {
    if (!accessToken || !playlistsLoaded) return;
    renderPlaylistSuggestions(playlistInput.value);
  });
}

// Klick außerhalb schließt Dropdown
document.addEventListener("click", (e) => {
  const wrapper = e.target.closest(".playlist-input-wrapper");
  if (!wrapper) {
    hidePlaylistSuggestions();
  }
});

// Optional: Spotify SDK Ready hook bleibt, macht aber nichts Kritisches
window.onSpotifyWebPlaybackSDKReady = () => {
  console.log("Spotify Web Playback SDK geladen (wird in dieser Version nicht aktiv genutzt).");
};

// Initial
setupModeToggle();
updateCountdownDisplay();
resetSolutionView();
resetCategory();
setPlayerStatus(false, "Player nicht verbunden");

// Beim Laden: schauen, ob wir aus dem OAuth-Redirect kommen
handleRedirectCallback();
