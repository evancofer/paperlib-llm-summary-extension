import { randomBytes } from "crypto";
import { readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

import { PLAPI, PLExtAPI, PLExtension, PLMainAPI } from "paperlib-api/api";
import type { PaperEntity } from "paperlib-api/model";
import { urlUtils } from "paperlib-api/utils";

import { formatReport, mapLimit, PaperResult } from "./batch";
import { extractPages } from "./extract/pdf";
import { pageTokens, selectText, Selection } from "./extract/select";
import { callAnthropic } from "./llm/anthropic";
import { callClaudeCode } from "./llm/claude-code";
import { HttpError, LLMRequest, LLMResponse, PostJson, providerMessage } from "./llm/http";
import { callOpenAI } from "./llm/openai";
import { buildSystemPrompt, buildUserMessage } from "./llm/prompt";
import { applySummary, hasEditedSummary } from "./note/markers";
import { pickerStub, startPickerServer } from "./picker/server";
import { PreferenceStore, Secrets } from "./secrets";
import {
  afterProviderSwitch,
  defaultPreference,
  Provider,
  readSettings,
  Settings,
} from "./settings";

const EXTENSION_ID = "@evancofer/paperlib-llm-summary-extension";
const LOG_ID = "LLMSummaryExt";
const CONCURRENCY = 2;
const PICKER_WINDOW_ID = "llmsummary-picker";

const ACTIONS = {
  summarize: {
    command: "llmsummary",
    label: "LLM Summary - summarize",
    description: "Summarize the selected papers with an LLM",
  },
  selection: {
    command: "llmsummary_selection",
    label: "LLM Summary - summarize from selection",
    description: "Choose which pages of the selected paper to summarize",
  },
};
type Action = keyof typeof ACTIONS;

const errorMessage = (error: unknown) =>
  (error as Error | undefined)?.message || String(error);

const postJson: PostJson = async (url, body, headers, timeoutMs) => {
  let response: { body: unknown };
  try {
    response = await PLExtAPI.networkTool.post(url, body, headers, 0, timeoutMs, false, true);
  } catch (error: any) {
    // Errors come from outside the sandbox, so `instanceof` can't identify them.
    if (typeof error?.response?.status === "number") {
      const text = await error.response.text().catch(() => "");
      throw new HttpError(error.response.status, providerMessage(text));
    }
    if (error?.name === "TimeoutError") {
      throw new Error(`No reply within ${timeoutMs / 1000} seconds`);
    }
    throw new Error(`Couldn't reach ${new URL(url).host}: ${errorMessage(error)}`);
  }

  if (typeof response.body !== "string") return response.body;
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error("The server's reply wasn't JSON. Check the base URL.");
  }
};

function callProvider(provider: Provider, request: LLMRequest): Promise<LLMResponse> {
  if (provider === "claude-code") return callClaudeCode(request);
  return provider === "anthropic" ? callAnthropic(request, postJson) : callOpenAI(request, postJson);
}

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function loadCurrent(paper: PaperEntity): Promise<PaperEntity> {
  const id = String((paper as any).id ?? (paper as any)._id);
  const [current] = Array.from(await PLAPI.paperService.loadByIds([id])) as PaperEntity[];
  if (!current) {
    throw new Error("The paper is no longer in the library");
  }
  return current;
}

async function saveNote(paper: PaperEntity, note: string) {
  paper.note = note;
  await PLAPI.paperService.update([paper] as any, false, true);
}

async function pdfPath(paper: PaperEntity): Promise<string> {
  const url = await PLAPI.fileService.access(paper.mainURL, true);
  if (!url) {
    throw new Error("The PDF file couldn't be found");
  }
  return urlUtils.eraseProtocol(url);
}

async function selectFromPdf(
  paper: PaperEntity,
  settings: Settings,
  pageList?: number[]
): Promise<Selection> {
  const pages = await extractPages(readFileSync(await pdfPath(paper)));
  return selectText(pages, { ...settings, pageList });
}

class LLMSummaryExtension extends PLExtension {
  disposeCallbacks: (() => void)[] = [];

  private readonly secrets = new Secrets(
    PLExtAPI.extensionPreferenceService as unknown as PreferenceStore,
    EXTENSION_ID,
    (message) => PLAPI.logService.warn("API key", message, true, LOG_ID)
  );

  constructor() {
    super({ id: EXTENSION_ID, defaultPreference });
  }

  async initialize() {
    const preferences = PLExtAPI.extensionPreferenceService;
    await preferences.register(this.id, this.defaultPreference);
    await this.secrets.migrate(this.setting("provider") as Provider);

    this.disposeCallbacks.push(
      preferences.onChanged(`${this.id}:apiKey` as any, () =>
        this.guard(() => this.secrets.onFieldChanged(this.setting("provider") as Provider))
      ),
      preferences.onChanged(`${this.id}:provider` as any, () =>
        this.guard(() => this.onProviderChanged())
      )
    );

    for (const [action, { command, description }] of Object.entries(ACTIONS)) {
      const event = `${this.id}/${command}`;
      this.disposeCallbacks.push(
        PLAPI.commandService.on(event as any, () => this.run(action as Action)),
        PLAPI.commandService.registerExternel({ id: command, description, event })
      );
    }

    PLMainAPI.contextMenuService.registerContextMenu(
      this.id,
      Object.entries(ACTIONS).map(([id, { label }]) => ({ id, label }))
    );
    this.disposeCallbacks.push(
      PLMainAPI.contextMenuService.on("dataContextMenuFromExtensionsClicked", (value) => {
        const { extID, itemID } = value.value;
        if (extID === this.id && itemID in ACTIONS) {
          this.run(itemID as Action);
        }
      })
    );
  }

  async dispose() {
    this.disposeCallbacks.forEach((dispose) => dispose());
    PLMainAPI.contextMenuService.unregisterContextMenu(this.id);
    PLExtAPI.extensionPreferenceService.unregister(this.id);
  }

  private setting(key: string): unknown {
    return PLExtAPI.extensionPreferenceService.get(this.id, key);
  }

  private notify(title: string, detail = "") {
    PLAPI.logService.info(title, detail, true, LOG_ID);
  }

  private fail(title: string, error: unknown) {
    PLAPI.logService.error(title, errorMessage(error), true, LOG_ID);
  }

  private async guard(task: () => Promise<void>) {
    try {
      await task();
    } catch (error) {
      this.fail("LLM Summary settings", error);
    }
  }

  private async onProviderChanged() {
    const provider = this.setting("provider") as Provider;
    PLExtAPI.extensionPreferenceService.set(
      this.id,
      afterProviderSwitch(provider, {
        baseURL: String(this.setting("baseURL") ?? ""),
        model: String(this.setting("model") ?? ""),
      })
    );
    await this.secrets.showFor(provider);
  }

  private async spinner(change: 1 | -1) {
    const key = "processingState.general";
    const current = Number(await PLAPI.uiStateService.getState(key as any)) || 0;
    await PLAPI.uiStateService.setState({ [key]: Math.max(0, current + change) } as any);
  }

  private async selectedPapers(): Promise<PaperEntity[]> {
    const papers = (await PLAPI.uiStateService.getState(
      "selectedPaperEntities"
    )) as PaperEntity[];
    if (!papers || papers.length === 0) {
      PLAPI.logService.warn("LLM Summary", "Select at least one paper first.", true, LOG_ID);
      return [];
    }
    return papers;
  }

  private async run(action: Action) {
    if (action === "selection") {
      await this.summarizeSelection();
      return;
    }

    await this.spinner(1);
    try {
      const papers = await this.selectedPapers();
      if (papers.length === 0) return;
      await this.summarize(papers, readSettings((key) => this.setting(key)));
    } catch (error) {
      this.fail("LLM Summary", error);
    } finally {
      await this.spinner(-1);
    }
  }

  /** Opens the page picker, and summarizes the chosen pages. */
  private async summarizeSelection() {
    try {
      const papers = await this.selectedPapers();
      if (papers.length === 0) return;
      if (papers.length > 1) {
        PLAPI.logService.warn("LLM Summary", "Choose pages for one paper at a time.", true, LOG_ID);
        return;
      }
      const [paper] = papers;
      if (!paper.mainURL) {
        PLAPI.logService.warn("LLM Summary", "This paper has no PDF.", true, LOG_ID);
        return;
      }
      const settings = readSettings((key) => this.setting(key));

      const pages = await this.choosePages(paper, settings);
      if (!pages || pages.length === 0) return;

      await this.spinner(1);
      try {
        const apiKey = await this.secrets.getKey(settings.provider);
        const result = await this.summarizeOne(paper, settings, apiKey, pages);
        this.report([result], settings);
      } finally {
        await this.spinner(-1);
      }
    } catch (error) {
      this.fail("LLM Summary", error);
    }
  }

  private report(results: PaperResult[], settings: Settings) {
    const message = formatReport(results, settings.maxInputTokens);
    if (results.some((r) => r.status === "summarized" && r.trimmedFrom)) {
      PLAPI.logService.warn("LLM Summary", message, true, LOG_ID);
    } else {
      this.notify("LLM Summary", message);
    }
  }

  private async choosePages(paper: PaperEntity, settings: Settings): Promise<number[] | null> {
    const file = await pdfPath(paper);
    const picker = await startPickerServer({
      pdfPath: file,
      title: paper.title,
      pageTokens: extractPages(readFileSync(file)).then((pages) =>
        pageTokens(pages, settings.stripRepeatedHeaders)
      ),
      maxTokens: settings.maxInputTokens,
      assetDir: path.join(__dirname, "picker"),
      cmapDir: path.join(__dirname, "cmaps"),
    });
    const stub = path.join(os.tmpdir(), `paperlib-llm-summary-picker-${randomBytes(8).toString("hex")}.html`);
    const windows = PLMainAPI.windowProcessManagementService;
    try {
      writeFileSync(stub, pickerStub(picker.base), "utf8");
      await windows.create(PICKER_WINDOW_ID, {
        entry: stub,
        title: "Choose pages",
        width: 1000,
        height: 760,
        minWidth: 480,
        minHeight: 360,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      } as any);
      return await picker.result;
    } finally {
      picker.close();
      rmSync(stub, { force: true });
      await windows.destroy(PICKER_WINDOW_ID);
    }
  }

  private async summarize(papers: PaperEntity[], settings: Settings) {
    if (papers.length > settings.batchLimit) {
      PLAPI.logService.warn(
        "LLM Summary",
        `${papers.length} papers selected, but the batch limit is ${settings.batchLimit}. Nothing was done.`,
        true,
        LOG_ID
      );
      return;
    }

    const apiKey = await this.secrets.getKey(settings.provider);
    const results = await mapLimit(papers, CONCURRENCY, async (paper): Promise<PaperResult> => {
      try {
        return await this.summarizeOne(paper, settings, apiKey);
      } catch (error) {
        const reason = errorMessage(error);
        PLAPI.logService.error(`Failed: ${paper.title}`, reason, false, LOG_ID);
        return { status: "failed", reason };
      }
    });
    this.report(results, settings);
  }

  private async summarizeOne(
    paper: PaperEntity,
    settings: Settings,
    apiKey: string,
    pageList?: number[]
  ): Promise<PaperResult> {
    if (!paper.mainURL) {
      return { status: "skipped", reason: "no PDF" };
    }
    // Checked before the call as well as after, so a skip costs nothing.
    if (settings.onEdited === "skip" && hasEditedSummary(paper.note ?? "")) {
      return { status: "skipped", reason: "edited summary present" };
    }

    const selection = await selectFromPdf(paper, settings, pageList);
    const request: LLMRequest = {
      baseURL: settings.baseURL,
      model: settings.model,
      apiKey,
      system: buildSystemPrompt(settings.language),
      user: buildUserMessage(
        settings.prompt,
        { title: paper.title, year: paper.pubTime, publication: paper.publication },
        selection.text
      ),
      maxOutputTokens: settings.maxOutputTokens,
      timeoutMs: settings.timeoutMs,
    };
    const reply = await callProvider(settings.provider, request);

    // The user may have edited the note during the call, so write to what's there now.
    const current = await loadCurrent(paper);
    const result = applySummary(
      current.note ?? "",
      reply.text,
      {
        id: randomBytes(4).toString("hex"),
        model: settings.model,
        date: today(),
        scope: pageList ? "picked" : settings.scope,
        pages: selection.pagesUsed,
      },
      settings
    );
    if (result.outcome === "skipped-edited") {
      return { status: "skipped", reason: "edited summary present" };
    }
    await saveNote(current, result.note);
    return {
      status: "summarized",
      cutOff: reply.cutOff,
      trimmedFrom: selection.truncated ? selection.fullTokens : undefined,
    };
  }

}

async function initialize() {
  const extension = new LLMSummaryExtension();
  await extension.initialize();
  return extension;
}

export { initialize };
