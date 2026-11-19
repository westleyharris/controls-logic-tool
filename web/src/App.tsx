import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { InputFile, ProjectModel } from "@core/model/types";
import { ProjectIndex } from "@core/query/index";
import { plc5SnapshotTime, runHealthChecks } from "@core/logic/health";
import { findAlarms, ioMap, scanStructure } from "@core/logic/overview";
import { DataFileView } from "./components/DataFileView";
import { AoiView, DataTypeView, ModulesView } from "./components/DefinitionViews";
import { Inspector } from "./components/Inspector";
import { AddMachineDialog, MachineLibrary } from "./components/MachineLibrary";
import { MachineSwitcher } from "./components/MachineSwitcher";
import { Organizer } from "./components/Organizer";
import { OverviewView } from "./components/OverviewView";
import { RoutineView } from "./components/RoutineView";
import { SearchPalette } from "./components/SearchPalette";
import { SettingsDialog } from "./components/SettingsDialog";
import { TagsView } from "./components/TagsView";
import { HealthView } from "./components/HealthView";
import { TroubleshootView } from "./components/TroubleshootView";
import { AlarmsView, IoMapView, StructureView } from "./components/InsightViews";
import { AssistantView } from "./components/AssistantView";
import { DrawingsView } from "./components/DrawingsView";
import { LibrarySearch, LibraryTabs, libraryTabFromHash, LIBRARY_TABS, NetworkView, PartsView, type LibraryTab } from "./components/LibraryViews";
import { ChecklistView, ConnectionsView, HandbookView } from "./components/MachineTools";
import { machineComms } from "@core/logic/connectivity";
import { analyzeProject } from "./lib/analysis";
import { saveEndpointLink } from "./lib/network";
import { useLibraryInsights } from "./lib/useInsights";
import { AccountDialog, CloudButton } from "./components/AccountDialog";
import { Icon } from "./components/Icon";
import { startAuth, useCloud } from "./lib/cloud";
import { ensureMachineFiles, onDrawingsChange, onSyncChange, requestSync, syncAttachments, syncNow } from "./lib/sync";
import { extractPdfText } from "./lib/pdf";
import { importInWorker, readExportFile } from "./lib/importer";
import {
  deleteMachine,
  deleteAttachment,
  listAttachments,
  putAttachment,
  type Attachment,
  getMachine,
  lastMachineId,
  listMachines,
  putMachine,
  rememberLastMachine,
  requestPersistentStorage,
  updateMachine,
  detailsPatch,
  renameCompany,
  renameLine,
  type Machine,
  type MachineDetails,
  type MachineSummary,
  getInsights,
  insightsFresh,
  deleteMachineLocal,
  putInsights,
  INSIGHTS_VERSION,
} from "./lib/machines";
import { fromHash, toHash, type Location, type Selection } from "./lib/nav";
import { useLadderPrefs, useStoredNumber } from "./lib/prefs";
import { buildSearchIndex, type SearchItem } from "./lib/search";
import { useTheme } from "./lib/theme";

/** Pre-filled answers for the add-machine dialog (and the network endpoint it came from). */
type AddPreset = { company: string; line: string; name?: string; endpoint?: string };

/** True on phone-sized screens, where the side panes become drawers. */
function useNarrow(query = "(max-width: 760px)"): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function summarize(files: InputFile[], model: ProjectModel) {
  return {
    projectName: model.name,
    platform: model.platform,
    processor: model.controller.processorType,
    fileNames: files.map((f) => f.name),
    size: files.reduce((a, f) => a + f.text.length, 0),
  };
}

export default function App() {
  const [machines, setMachines] = useState<MachineSummary[]>([]);
  const [current, setCurrent] = useState<MachineSummary | null>(null);
  const [project, setProject] = useState<ProjectModel | null>(null);
  const [location, setLocation] = useState<Location>({ view: "overview" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState<string | null>(() =>
    fromHash(window.location.hash) && lastMachineId() ? "Reopening your last machine…" : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pendingAdd, setPendingAdd] = useState<{
    files: InputFile[];
    model: ProjectModel;
    preset?: AddPreset;
  } | null>(null);
  const [libraryTab, setLibraryTab] = useState<LibraryTab>(() => libraryTabFromHash(window.location.hash));
  const [networkFocus, setNetworkFocus] = useState<string | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const cloud = useCloud();
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [organizerOpen, setOrganizerOpen] = useState(true);
  const [organizerW, setOrganizerW] = useStoredNumber("clt-organizer-w", 290);
  const [inspectorW, setInspectorW] = useStoredNumber("clt-inspector-w", 370);
  const [prefs, setPrefs] = useLadderPrefs();
  const [theme, toggleTheme] = useTheme();
  const centerRef = useRef<HTMLElement>(null);
  const narrow = useNarrow();
  // Going phone-sized (or rotating): side panes become drawers, closed until asked for.
  useEffect(() => {
    if (narrow) {
      setOrganizerOpen(false);
      setInspectorOpen(false);
    }
  }, [narrow]);

  const index = useMemo(() => (project ? new ProjectIndex(project) : null), [project]);
  const searchIndex = useMemo(() => (project ? buildSearchIndex(project) : []), [project]);
  const health = useMemo(() => (index ? runHealthChecks(index) : []), [index]);
  const structure = useMemo(() => (index ? scanStructure(index) : { tasks: [], unreachable: [] }), [index]);
  const io = useMemo(() => (index ? ioMap(index) : []), [index]);
  const alarms = useMemo(() => (index ? findAlarms(index) : []), [index]);
  const comms = useMemo(() => (index ? machineComms(index) : null), [index]);
  const library = useLibraryInsights(machines, !project && libraryTab !== "machines");

  const refreshMachines = useCallback(async () => {
    try {
      const list = await listMachines();
      setMachines(list);
      return list;
    } catch (err) {
      setError(`Couldn't read the machine library: ${errorText(err)}`);
      return [];
    }
  }, []);

  /* --------------------------------- navigation -------------------------------- */

  const navigate = useCallback((loc: Location) => {
    setLocation(loc);
    const hash = toHash(loc);
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
  }, []);

  const goLibrary = useCallback(
    (push = true, tab: LibraryTab = "machines") => {
      setProject(null);
      setCurrent(null);
      setSelection(null);
      setLibraryTab(tab);
      rememberLastMachine(null);
      if (push) window.history.pushState(null, "", LIBRARY_TABS.find((t) => t.id === tab)!.hash);
      void refreshMachines();
    },
    [refreshMachines],
  );

  const switchLibraryTab = (tab: LibraryTab) => {
    setLibraryTab(tab);
    setNetworkFocus(undefined);
    const hash = LIBRARY_TABS.find((t) => t.id === tab)!.hash;
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
  };

  useEffect(() => {
    const onPop = () => {
      const loc = fromHash(window.location.hash);
      if (loc) setLocation(loc);
      else goLibrary(false, libraryTabFromHash(window.location.hash));
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, [goLibrary]);

  // New view starts at the top (a routine opened at a rung scrolls itself to that rung).
  const locationKey = toHash(location.view === "routine" ? { view: "routine", ref: location.ref } : location);
  useEffect(() => {
    // On a phone the drawer and the inspector sheet cover the page: close them when you go somewhere.
    if (window.matchMedia("(max-width: 760px)").matches) {
      setOrganizerOpen(false);
      setInspectorOpen(false);
    }
    if (location.view === "routine" && location.rung !== undefined) return;
    centerRef.current?.scrollTo({ top: 0 });
  }, [locationKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------- machines --------------------------------- */

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = current?.id ?? null;

  const show = useCallback(
    (machine: MachineSummary, model: ProjectModel, loc?: Location, sel?: Selection) => {
      setProject(model);
      setCurrent(machine);
      setAttachments([]);
      void listAttachments(machine.id).then(setAttachments);
      // Drawings added on other devices come down when the machine is opened.
      void syncAttachments(machine.id)
        .then((changed) => (changed ? listAttachments(machine.id).then(setAttachments) : undefined))
        .catch(() => undefined);
      setSelection(sel ?? null);
      const wide = window.innerWidth > 760;
      setOrganizerOpen(wide);
      setInspectorOpen(wide);
      const target = loc ?? { view: "overview" as const };
      setLocation(target);
      window.history.pushState(null, "", toHash(target));
      rememberLastMachine(machine.id);
      void updateMachine(machine.id, { openedAt: Date.now() }).then(() => refreshMachines());
    },
    [refreshMachines],
  );

  const openMachine = useCallback(
    async (id: string, loc?: Location, sel?: Selection) => {
      setError(null);
      let m = await getMachine(id);
      if (!m) {
        setError("That machine is no longer in the library.");
        return;
      }
      setBusy(m.remote || !m.files.length ? `Downloading ${m.name}…` : `Opening ${m.name}…`);
      try {
        if (m.remote || !m.files.length) {
          m = await ensureMachineFiles(m);
          setBusy(`Opening ${m.name}…`);
          void refreshMachines();
        }
        const model = await importInWorker(m.files);
        const { files: _files, ...summary } = m;
        show(summary, model, loc, sel);
      } catch (err) {
        setError(`Couldn't open ${m.name}: ${errorText(err)}`);
      } finally {
        setBusy(null);
      }
    },
    [show],
  );

  const parseFiles = async (files: File[]) => {
    setBusy(`Reading ${files.map((f) => f.name).join(", ")}…`);
    const inputs = await Promise.all(files.map(readExportFile));
    const model = await importInWorker(inputs);
    return { inputs, model };
  };

  const addMachine = async (files: File[], preset?: AddPreset) => {
    setError(null);
    try {
      const { inputs, model } = await parseFiles(files);
      setPendingAdd(preset ? { files: inputs, model, preset } : { files: inputs, model });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const savePending = async (details: MachineDetails) => {
    if (!pendingAdd) return;
    const now = Date.now();
    const machine: Machine = {
      id: crypto.randomUUID(),
      ...detailsPatch(details),
      name: details.name,
      ...summarize(pendingAdd.files, pendingAdd.model),
      addedAt: now,
      updatedAt: now,
      files: pendingAdd.files,
      exportVersion: 0,
      dirty: true,
      filesDirty: true,
    };
    try {
      await putMachine(machine);
      const { files: _files, ...summary } = machine;
      const model = pendingAdd.model;
      // Added from the network map: remember which message target this machine is.
      if (pendingAdd.preset?.endpoint) saveEndpointLink(pendingAdd.preset.endpoint, machine.id);
      setPendingAdd(null);
      show(summary, model);
      requestSync();
    } catch (err) {
      setError(`Couldn't save the machine: ${errorText(err)}`);
    }
  };

  const updateExport = async (id: string, files: File[]) => {
    setError(null);
    try {
      const { inputs, model } = await parseFiles(files);
      await updateMachine(id, { ...summarize(inputs, model), files: inputs, updatedAt: Date.now(), filesDirty: true, remote: false });
      requestSync();
      await refreshMachines();
      if (current?.id === id) await openMachine(id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const editMachine = async (id: string, details: MachineDetails) => {
    const next = await updateMachine(id, detailsPatch(details));
    requestSync();
    await refreshMachines();
    if (next && current?.id === id) {
      const { files: _files, ...summary } = next;
      setCurrent(summary);
    }
  };

  const renameGroup = async (rename: () => Promise<void>) => {
    await rename();
    requestSync();
    const list = await refreshMachines();
    if (current) setCurrent(list.find((m) => m.id === current.id) ?? current);
  };

  /** Store drawings (PDF / images) with the current machine; PDFs get their text indexed. */
  const addDrawings = async (files: File[]) => {
    if (!current) return;
    setError(null);
    try {
      for (const f of files) {
        const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
        let pagesText: string[] | undefined;
        if (isPdf) {
          setBusy(`Reading ${f.name}…`);
          pagesText = await extractPdfText(f, (p, t) => setBusy(`Indexing ${f.name} — page ${p} of ${t}…`));
        }
        await putAttachment({
          id: crypto.randomUUID(),
          machineId: current.id,
          kind: "drawing",
          name: f.name,
          mime: isPdf ? "application/pdf" : f.type || "image/jpeg",
          size: f.size,
          ...(pagesText ? { pageCount: pagesText.length, pagesText } : {}),
          addedAt: Date.now(),
          blob: f,
        });
      }
      setAttachments(await listAttachments(current.id));
      const id = current.id;
      void syncAttachments(id, false).catch(() => requestSync());
    } catch (err) {
      setError(`Couldn't add the drawing: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const removeDrawing = async (id: string) => {
    await deleteAttachment(id);
    if (current) {
      setAttachments(await listAttachments(current.id));
      void syncAttachments(current.id, false).catch(() => undefined);
    }
  };

  const removeMachine = async (id: string) => {
    await deleteMachine(id);
    requestSync(0);
    if (current?.id === id) goLibrary();
    else await refreshMachines();
  };

  // Cloud: restore the session, sync when signed in, when back online and when the app comes back to the front.
  useEffect(() => {
    onSyncChange(() => void refreshMachines());
    onDrawingsChange((machineId) => {
      if (currentIdRef.current === machineId) void listAttachments(machineId).then(setAttachments);
    });
    void startAuth(() => void syncNow());
    const wake = () => {
      if (document.visibilityState === "visible") requestSync(500);
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refreshMachines]);

  // Startup: load the library; if the URL points inside a machine, reopen the last one.
  useEffect(() => {
    requestPersistentStorage();
    void (async () => {
      const list = await refreshMachines();
      const loc = fromHash(window.location.hash);
      const last = lastMachineId();
      if (loc && last && list.some((m) => m.id === last)) await openMachine(last, loc);
      else setBusy(null);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.title = current ? `${current.name} · Controls Logic Tool` : "Controls Logic Tool";
  }, [current]);

  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener("clt-open-settings", open);
    return () => window.removeEventListener("clt-open-settings", open);
  }, []);

  // Keep this machine's library facts (network, parts, search-all) current.
  useEffect(() => {
    if (!project || !index || !current) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void getInsights(current.id).then((stored) => {
        if (cancelled || insightsFresh(stored, current)) return;
        const analysis = analyzeProject(project, index, searchIndex);
        void putInsights({ ...analysis, machineId: current.id, version: INSIGHTS_VERSION, stamp: current.updatedAt });
      });
    }, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [project, index, current, searchIndex]);

  /* ---------------------------------- search ----------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && project) {
        e.preventDefault();
        setSearchOpen((x) => !x);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project]);

  const select = useCallback(
    (sel: Selection) => {
      setSelection(sel);
      setInspectorOpen(true);
      if (narrow) setOrganizerOpen(false);
    },
    [narrow],
  );

  /** From the organizer: on a phone, close the drawer once something is picked. */
  const navigateFromTree = useCallback(
    (loc: Location) => {
      navigate(loc);
      if (narrow) setOrganizerOpen(false);
    },
    [navigate, narrow],
  );

  const pick = (item: SearchItem) => {
    setSearchOpen(false);
    navigate(item.go);
    if (item.select) select(item.select);
  };

  /* ------------------------------- pane resizing ------------------------------- */

  const startResize = (side: "left" | "right") => (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => {
      const w = side === "left" ? ev.clientX : window.innerWidth - ev.clientX;
      const clamped = Math.max(200, Math.min(600, w));
      if (side === "left") setOrganizerW(clamped);
      else setInspectorW(clamped);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    document.body.classList.add("resizing");
  };

  /* ----------------------------------- render ---------------------------------- */

  return (
    <div className="shell">
      <header className="topbar">
        {project ? (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setOrganizerOpen((x) => !x)}
            aria-label="Toggle organizer"
            title="Toggle organizer"
          >
            <Icon name="menu" size={20} />
          </button>
        ) : null}
        <button type="button" className={`brand${project ? " in-machine" : ""}`} onClick={() => goLibrary()} title="All machines">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">Controls Logic Tool</span>
        </button>
        {project && current ? (
          <>
            <div className="nav-arrows">
              <button type="button" className="icon-btn" onClick={() => window.history.back()} aria-label="Back" title="Back">
                <Icon name="chevron-left" />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => window.history.forward()}
                aria-label="Forward"
                title="Forward"
              >
                <Icon name="chevron-right" />
              </button>
            </div>
            <MachineSwitcher
              current={current}
              machines={machines}
              onOpen={(id) => void openMachine(id)}
              onLibrary={() => goLibrary()}
              onAdd={(f) => void addMachine(f)}
            />
          </>
        ) : null}
        <div className="topbar-spacer" />
        {project ? (
          <button type="button" className="btn ask-btn" onClick={() => navigate({ view: "assistant" })} title="Describe a problem and let the AI find it" aria-label="Ask AI">
            <Icon name="sparkles" size={16} />
            <span className="ask-text">Ask AI</span>
          </button>
        ) : null}
        {project ? (
          <button type="button" className="search-trigger" onClick={() => setSearchOpen(true)} aria-label="Search">
            <Icon name="search" size={16} className="search-ico" />
            <span className="search-text">Search tags, addresses, comments…</span>
            <kbd>⌘K</kbd>
          </button>
        ) : null}
        <CloudButton onClick={() => setAccountOpen(true)} />
        <button type="button" className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings (Ask AI key, theme)">
          <Icon name="settings" />
        </button>
        <button
          type="button"
          className="icon-btn theme-btn"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
      </header>

      {!project || !index || !current ? (
        <main className="library-wrap">
          {machines.length ? <LibraryTabs tab={libraryTab} onTab={switchLibraryTab} progress={library.progress} /> : null}
          {libraryTab === "machines" || !machines.length ? (
            <MachineLibrary
              machines={machines}
              error={error}
              onOpen={(id) => void openMachine(id)}
              onAdd={(f, preset) => void addMachine(f, preset)}
              onEdit={(id, d) => void editMachine(id, d)}
              onRenameCompany={(from, to) => void renameGroup(() => renameCompany(from, to))}
              onRenameLine={(company, from, to) => void renameGroup(() => renameLine(company, from, to))}
              onUpdateExport={(id, f) => void updateExport(id, f)}
              onDelete={(id) => void removeMachine(id)}
              cloudEmail={cloud.user?.email}
            />
          ) : null}
          {error && libraryTab !== "machines" ? <div className="notice error lib-view">{error}</div> : null}
          {libraryTab === "search" && machines.length ? (
            <LibrarySearch machines={machines} insights={library.insights} progress={library.progress} onOpen={(id, go, sel) => void openMachine(id, go, sel)} />
          ) : null}
          {libraryTab === "network" && machines.length ? (
            <NetworkView
              machines={machines}
              insights={library.insights}
              progress={library.progress}
              {...(networkFocus ? { focus: networkFocus } : {})}
              onOpen={(id, go) => void openMachine(id, go)}
              onAddEndpoint={(f, preset) => void addMachine(f, preset)}
            />
          ) : null}
          {libraryTab === "parts" && machines.length ? <PartsView machines={machines} insights={library.insights} progress={library.progress} /> : null}
        </main>
      ) : (
        <div
          className="workspace"
          style={{
            gridTemplateColumns: `${organizerOpen ? `${organizerW}px` : "0px"} minmax(0, 1fr) ${inspectorOpen ? `${inspectorW}px` : "0px"}`,
          }}
        >
          <div className="pane-wrap">
            {organizerOpen ? (
              <>
                <Organizer
                  project={project}
                  storageKey={current.id}
                  location={location}
                  issues={health.filter((f) => f.severity !== "info").length}
                  activeAlarms={alarms.filter((a) => a.active === true).length}
                  drawings={attachments.length}
                  onNavigate={navigateFromTree}
                />
                <div className="resizer right" onPointerDown={startResize("left")} aria-hidden />
              </>
            ) : null}
          </div>
          {narrow && (organizerOpen || inspectorOpen) ? (
            <div
              className="drawer-backdrop"
              onClick={() => {
                setOrganizerOpen(false);
                setInspectorOpen(false);
              }}
              aria-hidden
            />
          ) : null}
          <main className="center" ref={centerRef}>
            {error ? (
              <div className="notice error">
                {error}
                <button type="button" className="link" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </div>
            ) : null}
            {location.view === "overview" ? (
              <OverviewView
                project={project}
                index={index}
                health={health}
                structure={structure}
                io={io}
                alarms={alarms}
                onNavigate={navigate}
                onSelect={select}
              />
            ) : null}
            {location.view === "structure" ? <StructureView structure={structure} onNavigate={navigate} /> : null}
            {location.view === "io" ? <IoMapView groups={io} isLogix={index.isLogix} nav={{ onNavigate: navigate, onSelect: select }} /> : null}
            {location.view === "alarms" ? <AlarmsView alarms={alarms} index={index} nav={{ onNavigate: navigate, onSelect: select }} /> : null}
            {location.view === "assistant" ? (
              <AssistantView
                key={current.id}
                index={index}
                machineKey={current.id}
                attachments={attachments}
                onNavigate={navigate}
                onSelect={select}
              />
            ) : null}
            {location.view === "connections" && comms ? (
              <ConnectionsView
                comms={comms}
                index={index}
                onNavigate={navigate}
                onSelect={select}
                onOpenNetwork={() => {
                  setNetworkFocus(current.id);
                  goLibrary(true, "network");
                }}
              />
            ) : null}
            {location.view === "checklist" ? (
              <ChecklistView
                key={`${location.ref ?? ""}`}
                index={index}
                items={searchIndex}
                io={io}
                machineKey={current.id}
                {...(location.ref ? { refName: location.ref } : {})}
                {...(location.where ? { where: location.where } : {})}
                onNavigate={navigate}
                onSelect={select}
              />
            ) : null}
            {location.view === "handbook" ? (
              <HandbookView index={index} alarms={alarms} machineKey={current.id} machineName={current.name} onNavigate={navigate} onSelect={select} />
            ) : null}
            {location.view === "drawings" ? (
              <DrawingsView
                attachments={attachments}
                {...(location.id ? { selectedId: location.id } : {})}
                {...(location.page ? { page: location.page } : {})}
                onAdd={(f) => void addDrawings(f)}
                onDelete={(id) => void removeDrawing(id)}
                onNavigate={navigate}
              />
            ) : null}
            {location.view === "routine" ? (
              <RoutineView
                key={`${location.ref.kind}/${location.ref.owner}/${location.ref.routine}/${location.instance ? JSON.stringify(location.instance) : ""}`}
                index={index}
                where={location.ref}
                instance={location.instance}
                focusRung={location.rung}
                selection={selection}
                prefs={prefs}
                onPrefs={setPrefs}
                onSelect={select}
                onNavigate={navigate}
              />
            ) : null}
            {location.view === "tags" ? (
              <TagsView project={project} scope={location.scope} selection={selection} onSelect={select} />
            ) : null}
            {location.view === "datafile" ? (
              <DataFileView project={project} index={index} name={location.name} selection={selection} onSelect={select} />
            ) : null}
            {location.view === "aoi" ? (
              <AoiView index={index} name={location.name} onNavigate={navigate} onSelect={select} />
            ) : null}
            {location.view === "datatype" ? <DataTypeView project={project} name={location.name} /> : null}
            {location.view === "modules" ? <ModulesView project={project} /> : null}
            {location.view === "troubleshoot" ? (
              <TroubleshootView
                index={index}
                items={searchIndex}
                {...(location.ref ? { refName: location.ref } : {})}
                {...(location.where ? { where: location.where } : {})}
                onNavigate={navigate}
                onSelect={select}
              />
            ) : null}
            {location.view === "health" ? (
              <HealthView
                findings={health}
                {...(index && plc5SnapshotTime(index) ? { snapshot: plc5SnapshotTime(index)! } : {})}
                onNavigate={navigate}
                onSelect={select}
              />
            ) : null}
          </main>
          <div className="pane-wrap">
            {inspectorOpen ? (
              <>
                <div className="resizer left" onPointerDown={startResize("right")} aria-hidden />
                <Inspector
                  index={index}
                  attachments={attachments}
                  selection={selection}
                  onSelect={select}
                  onNavigate={navigate}
                  onClose={() => setInspectorOpen(false)}
                />
              </>
            ) : (
              <button type="button" className="inspector-tab" onClick={() => setInspectorOpen(true)}>
                Inspector
              </button>
            )}
          </div>
        </div>
      )}

      {busy ? (
        <div className="overlay">
          <div className="busy">
            <span className="spinner" aria-hidden />
            {busy}
          </div>
        </div>
      ) : null}
      {pendingAdd ? (
        <AddMachineDialog
          model={pendingAdd.model}
          fileNames={pendingAdd.files.map((f) => f.name)}
          machines={machines}
          preset={pendingAdd.preset}
          onSave={(d) => void savePending(d)}
          onCancel={() => setPendingAdd(null)}
        />
      ) : null}
      {settingsOpen ? <SettingsDialog theme={theme} onToggleTheme={toggleTheme} onClose={() => setSettingsOpen(false)} /> : null}
      {accountOpen ? (
        <AccountDialog
          onClose={() => setAccountOpen(false)}
          onSignedOut={() =>
            // Cloud-only machines (never downloaded here) leave with the account.
            void listMachines()
              .then((list) => Promise.all(list.filter((m) => m.remote).map((m) => deleteMachineLocal(m.id))))
              .then(() => refreshMachines())
          }
        />
      ) : null}
      {searchOpen && project ? (
        <SearchPalette items={searchIndex} onPick={pick} onClose={() => setSearchOpen(false)} />
      ) : null}
    </div>
  );
}
