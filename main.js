/* DOCK-47B Terminal — Foundry VTT Module (v13 verified)
 * - Shared State via game.settings + socket broadcast
 */

const MODULE_ID = "dock-47b-terminal";
const SOCKET_EVENT = `module.${MODULE_ID}`;
const SETTING_KEY = "terminalState";

function defaultStateRaw() {
  return {
    node: "terminal", alarm: 0, access: "GAST", status: "LOCKED",
    selectedContainerId: null, selectedCamId: null,
    showAuthUI: false, authMode: "login",
    offlineCams: [], camIncidentTriggered: false, camSecondIncidentTriggered: false,
    warnedAt3: false, lockedOut: false, postedTeam2: false, sessionLog: []
  };
}

function loadState() {
  try {
    const raw = game.settings.get(MODULE_ID, SETTING_KEY);
    return { ...raw, offlineCams: new Set(raw.offlineCams ?? []) };
  } catch {
    return { ...defaultStateRaw(), offlineCams: new Set() };
  }
}

async function saveAndBroadcast(state) {
  const raw = { ...state, offlineCams: [...state.offlineCams] };
  await game.settings.set(MODULE_ID, SETTING_KEY, raw);
  game.socket.emit(SOCKET_EVENT, { type: "stateUpdate", state: raw });
}

class Dock47BTerminal extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "dock-47b-terminal-app",
      title: "DOCK-47B // Fracht-Terminal",
      template: `modules/${MODULE_ID}/templates/terminal.hbs`,
      classes: ["dock47b-terminal"],
      width: 1050,
      height: 760,
      resizable: true
    });
  }

  constructor(options = {}) {
    super(options);
    // State wird aus dem world-Setting geladen (shared across all clients)
    this._stateLoaded = false;

    this.CFG = {
      overrideKey: "47B-2219-SEC2309",
      operatorName: "Operator S. Kestrel",

      containers: [
        {
          id: "CTR-47B-0107",
          label: "Standard Fracht",
          owner: "CANBERRA PORT AUTH",
          contents: "Verpackte Ersatzteile (Dock-Ausrüstung), Palettenware",
          dest: "VAL-2 Canberra • Lagersektor D-12"
        },
        {
          id: "CTR-47B-0144",
          label: "Kühlgut",
          owner: "AURORA FOODS",
          contents: "Kühlcontainer: Nährstoffrationen, medizinische Grundstoffe",
          dest: "VAL-2 Canberra • Versorgungsknoten C-03"
        },
        {
          id: "CTR-47B-2219",
          label: "Mining Equipment // DEL-CORP",
          owner: "DEL-CORP",
          contents: "Bergbau-Ausrüstung: Bohrköpfe, Servomotoren, Ersatzmodule",
          dest: "Freihandelszone • Transit-Hub F-07"
        },
        {
          id: "CTR-47B-0331",
          label: "Versiegelte Kiste",
          owner: "UNLISTED",
          contents: "Versiegelte Versandkiste (Dokumente: unlesbar, Gewicht: unplausibel)",
          dest: "VAL-2 Canberra • Zoll-Inspektion B-01"
        }
      ],

      cams: [
        { id: "CAM-01", label: "Kamera 01 — Dock Tor" },
        { id: "CAM-02", label: "Kamera 02 — Containerreihe" },
        { id: "CAM-03", label: "Kamera 03 — Kranarm" },
        { id: "CAM-04", label: "Kamera 04 — Zollzone" }
      ],

      firstFailCam: "CAM-03",
      secondFailCam: "CAM-02",

      warnAt: 3,
      lockAt: 4
    };

    this.state = loadState();
  }

  _now() {
    return new Date().toLocaleTimeString();
  }

  _pushLog(text, cls = "") {
    this.state.sessionLog.push({ t: this._now(), text, cls });
    if (this.state.sessionLog.length > 200) this.state.sessionLog.shift();
  }

  async _sendChat(msg, color = "#45baff", gmOnly = false) {
    if (!game?.ready) return;

    const data = {
      speaker: ChatMessage.getSpeaker(),
      content: `<span style="color:${color};font-weight:800">${msg}</span>`
    };

    if (gmOnly) data.whisper = game.users.filter(u => u.isGM).map(u => u.id);
    return ChatMessage.create(data);
  }

  _setStatus(status) {
    this.state.status = status;
  }

  _guardLockedOut(actionLabel) {
    if (!this.state.lockedOut) return false;
    this._pushLog(`BLOCKED: ${actionLabel} (System gesperrt).`, "alarm");
    return true;
  }

  async _incAlarm(reason, narrative = null) {
    if (this.state.lockedOut) return;

    this.state.alarm += 1;
    this._pushLog(`ALARM +1: ${reason}`, "alarm");

    const chatMsg = narrative ?? "Das Terminal gibt einen kurzen Ton von sich. Eine rote Kontrollleuchte blinkt auf.";
    await this._sendChat(chatMsg, "#ff4b73", false);

    if (this.state.alarm >= this.CFG.warnAt && !this.state.warnedAt3) {
      this.state.warnedAt3 = true;
      ui.notifications.warn("WARNUNG: 3 Alarme. Ein weiterer Alarm sperrt das System.");
    }

    if (this.state.alarm >= this.CFG.lockAt) {
      this.state.lockedOut = true;
      this._setStatus("LOCKED_OUT");
      this._pushLog("SYSTEM: Zugriff gesperrt. Sicherheitsmeldung ausgelöst.", "alarm");
      await this._sendChat("Sirenen heulen auf. Rote Warnlichter flackern über dem Terminal — das Gerät ist gesperrt. Irgendwo im Dock sind Schritte zu hören.", "#ff4b73", false);
    }

    await saveAndBroadcast(this.state);
    this.render();
  }

  _requireOperator(actionLabel) {
    if (this.state.access !== "OPERATOR") {
      this._incAlarm(`${actionLabel} verweigert (Gastzugang).`);
      return false;
    }
    return true;
  }

  _triggerFirstCamIncident() {
    if (this.state.camIncidentTriggered) return;
    this.state.camIncidentTriggered = true;
    this.state.offlineCams.add(this.CFG.firstFailCam);
    this._pushLog(`CAM: ${this.CFG.firstFailCam} Signal instabil → offline.`, "alarm");
    this._sendChat(`Irgendwo über den Containerreihen erlischt abrupt ein Kameralicht.`, "#ff4b73", false);
  }

  _triggerSecondCamIncident() {
    if (this.state.camSecondIncidentTriggered) return;
    this.state.camSecondIncidentTriggered = true;
    this.state.offlineCams.add(this.CFG.secondFailCam);
    this._pushLog(`CAM: ${this.CFG.secondFailCam} Signal instabil → offline.`, "alarm");
    this._sendChat(`Ein zweites Kameralicht an der Containerreihe flackert kurz — dann Dunkelheit.`, "#ff4b73", false);
  }

  getData() {
    const s = this.state;

    const containers = this.CFG.containers.map(c => ({
      ...c,
      isSpecial: (c.label || "").includes("DEL-CORP"),
      isSelected: s.selectedContainerId === c.id
    }));

    const cams = this.CFG.cams.map(c => ({
      ...c,
      isOffline: s.offlineCams.has(c.id),
      isSelected: s.selectedCamId === c.id
    }));

    const selectedContainer = s.selectedContainerId
      ? (this.CFG.containers.find(x => x.id === s.selectedContainerId) ?? null)
      : null;

    const selectedCam = s.selectedCamId
      ? (this.CFG.cams.find(x => x.id === s.selectedCamId) ?? null)
      : null;

    const camScenes = {
      "CAM-01": "Dock-Tor geöffnet. Bodenpersonal markiert eine Spur. Zwei Loader ziehen leere Paletten in den Innenbereich.",
      "CAM-02": "Containerreihe ruhig. Ein Wartungsdrohn surrt langsam an der Außenkante entlang. Keine Abweichungen.",
      "CAM-03": "Kranarm über dem Dock. Statusanzeigen stabil. Arbeitslicht flackert kurz, dann wieder normal.",
      "CAM-04": "Zollzone: Beleuchtung stabil. Ein Scanner läuft über eine Palette. Ein Beamter tippt auf ein Terminal."
    };

    const baseAudit = [
      "AUDIT: Session TEMP-GUEST verbunden",
      "AUDIT: Node-Index geladen (manifest/cams/logs)"
    ];

    const afterOp = [
      `AUDIT: OVERRIDE ACCEPTED — user=${this.CFG.operatorName} — scope=OPERATOR`,
      "AUDIT: OVERRIDE ACCEPTED — user=Operator R. Vance — scope=OPERATOR",
      "AUDIT: ACCESS — user=Operator R. Vance — node=manifest — item=CTR-47B-2219 (Mining Equipment // DEL-CORP)"
    ];

    return {
      alarm: s.alarm,
      access: s.access,
      status: s.status,
      lockedOut: s.lockedOut,

      node: s.node,

      showAuthUI: s.showAuthUI,
      authMode: s.authMode,

      containers,
      cams,
      selectedContainer,
      selectedCam,
      camSceneText: selectedCam ? (camScenes[selectedCam.id] || "Feed aktiv.") : "",

      auditBaseText: baseAudit.join("\n"),
      auditOpText: (s.access === "OPERATOR") ? afterOp[0] : "",
      auditTeam2Text: (s.access === "OPERATOR") ? afterOp.slice(1).join("\n") : "",

      sessionLog: s.sessionLog
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-node]").on("click", ev => {
      ev.preventDefault();
      const node = ev.currentTarget.dataset.node;
      if (this._guardLockedOut(`Node ${node}`)) return;

      this.state.node = node;
      this.state.selectedContainerId = null;
      this.state.selectedCamId = null;
      this.state.showAuthUI = false;
      saveAndBroadcast(this.state);
      this.render();
    });

    html.find("[data-action='disconnect']").on("click", ev => {
      ev.preventDefault();
      this._resetSession();
    });

    html.find("[data-action='open-auth']").on("click", ev => {
      ev.preventDefault();
      if (this._guardLockedOut("Login")) return;
      this.state.showAuthUI = true;
      this.state.authMode = "login";
      this.state.node = "terminal";
      saveAndBroadcast(this.state);
      this.render();
    });

    html.find("[data-auth-tab]").on("click", ev => {
      ev.preventDefault();
      this.state.authMode = ev.currentTarget.dataset.authTab;
      saveAndBroadcast(this.state);
      this.render();
    });

    html.find("[data-action='do-login']").on("click", ev => {
      ev.preventDefault();
      if (this._guardLockedOut("Login attempt")) return;

      const u = (html.find("#login-user").val() ?? "").toString().trim();
      const p = (html.find("#login-pass").val() ?? "").toString().trim();

      if (!u || !p) {
        this._incAlarm("Login fehlgeschlagen (fehlende Eingabe).", "Das Terminal gibt einen kurzen Piepton von sich. Die Eingabemaske blinkt kurz rot auf.");
        return;
      }
      this._incAlarm("Login fehlgeschlagen (Ungültige Credentials).", "Das Terminal gibt einen schrillen Ton von sich. Die rote Kontrollleuchte blinkt dreimal auf.");
    });

    html.find("[data-action='do-override']").on("click", ev => {
      ev.preventDefault();
      if (this._guardLockedOut("Override")) return;

      const val = (html.find("#ov-key").val() ?? "").toString().trim();
      if (!val) {
        this._incAlarm("Override abgebrochen (kein Key).", "Das Terminal gibt einen kurzen Piepton von sich. Die Anzeige blinkt kurz rot auf.");
        return;
      }
      if (val === this.CFG.overrideKey) {
        this.state.access = "OPERATOR";
        this._setStatus("OPERATOR");
        this._pushLog(`AUTH OK: Willkommen ${this.CFG.operatorName}.`);
        this._sendChat(`Am Terminal beginnt eine grüne Lampe zu leuchten. Zugang gewährt — ${this.CFG.operatorName}.`, "#45baff", false);
        this.state.showAuthUI = false;

        if (!this.state.postedTeam2) {
          this.state.postedTeam2 = true;
          this._pushLog("AUDIT: OVERRIDE ACCEPTED — user=Operator R. Vance — scope=OPERATOR", "team2");
          this._pushLog("AUDIT: ACCESS — user=Operator R. Vance — node=manifest — item=CTR-47B-2219", "team2");
        }

        saveAndBroadcast(this.state);
        this.render();
        return;
      }
      this._incAlarm("Override abgelehnt (Key ungültig).", "Ein lautes Warnsignal ertönt vom Terminal. Die rote Leuchte beginnt gleichmäßig zu blinken.");
    });

    html.find("[data-container-id]").on("click", ev => {
      ev.preventDefault();
      if (this._guardLockedOut("Container select")) return;

      const id = ev.currentTarget.dataset.containerId;
      if (this.state.access !== "OPERATOR") {
        this._incAlarm(`Container-Detail ${id}`, "Das Terminal gibt einen abweisenden Ton von sich. Der Bildschirm flackert kurz.");
        return;
      }
      this.state.selectedContainerId = id;
      saveAndBroadcast(this.state);
      this.render();
    });

    html.find("[data-action='reroute']").on("click", ev => {
      ev.preventDefault();
      if (this._guardLockedOut("Umleitung")) return;

      const id = this.state.selectedContainerId;
      if (!id) return;
      if (!this._requireOperator(`Umleitung ${id}`)) return;

      this._setStatus("ROUTED");
      this._pushLog(`MANIFEST: ${id} Umleitung gesetzt (pending).`);
      this._sendChat(`Ein leises Summen — irgendwo im Dock setzt sich ein Fördermechanismus in Bewegung.`, "#45baff", false);
      saveAndBroadcast(this.state);
      this.render();
    });

    html.find("[data-action='open-container']").on("click", ev => {
      ev.preventDefault();
      if (this._guardLockedOut("Öffnen")) return;

      const id = this.state.selectedContainerId;
      if (!id) return;
      if (!this._requireOperator(`Öffnen ${id}`)) return;

      this._setStatus("OPENED");
      this._pushLog(`MANIFEST: ${id} Verriegelung entriegelt (manual).`);
      this._sendChat(`Mit einem dumpfen Klacken springt irgendwo im Dock eine Verriegelung auf.`, "#2a7d4f", false);
      saveAndBroadcast(this.state);
      this.render();
    });

    html.find("[data-cam-id]").on("click", ev => {
      ev.preventDefault();
      if (this._guardLockedOut("Kamera select")) return;

      const id = ev.currentTarget.dataset.camId;

      this._triggerFirstCamIncident();
      if (id === this.CFG.firstFailCam) this._triggerSecondCamIncident();

      this.state.selectedCamId = id;
      if (!this.state.offlineCams.has(id)) this._pushLog(`CAM: ${id} Feed geöffnet.`);
      saveAndBroadcast(this.state);
      this.render();
    });
  }

  _resetSession() {
    this.state = { ...defaultStateRaw(), offlineCams: new Set() };
    this._pushLog("SESSION RESET.");
    saveAndBroadcast(this.state);
    this.render();
  }
}

/** Singleton open */
let _dockApp = null;
function openDockTerminal() {
  if (_dockApp?.rendered) {
    _dockApp.bringToTop();
    return _dockApp;
  }
  _dockApp = new Dock47BTerminal();
  _dockApp.render(true);
  return _dockApp;
}

Hooks.once("ready", () => {
  // Setting registrieren (world-scope = alle Clients teilen denselben Wert)
  game.settings.register(MODULE_ID, SETTING_KEY, {
    name: "Terminal State",
    scope: "world",
    config: false,
    type: Object,
    default: defaultStateRaw()
  });

  // Socket-Listener: wenn ein anderer Client den State ändert, hier neu rendern
  game.socket.on(SOCKET_EVENT, (data) => {
    if (data?.type === "stateUpdate" && _dockApp?.rendered) {
      _dockApp.state = { ...data.state, offlineCams: new Set(data.state.offlineCams ?? []) };
      _dockApp.render();
    }
  });

  globalThis.openDock47BTerminal = openDockTerminal;
  console.log(`[${MODULE_ID}] ready`);
});

/** Scene Control Button (GM) */
Hooks.on("getSceneControlButtons", (controls) => {
  // V13: controls ist ein Object/Map, kein Array mehr
  const tokenTools = controls.tokens ?? controls.find?.(c => c.name === "token");
  if (!tokenTools) return;

  const toolList = tokenTools.tools ?? tokenTools;
  const alreadyAdded = Array.isArray(toolList)
    ? toolList.some(t => t.name === "dock47b-terminal")
    : toolList["dock47b-terminal"];
  if (alreadyAdded) return;

  const entry = {
    name: "dock47b-terminal",
    title: "DOCK-47B Terminal öffnen",
    icon: "fas fa-terminal",
    visible: game.user.isGM,
    onClick: () => openDockTerminal(),
    button: true
  };

  if (Array.isArray(toolList)) {
    toolList.push(entry);
  } else {
    toolList["dock47b-terminal"] = entry;
  }
});
