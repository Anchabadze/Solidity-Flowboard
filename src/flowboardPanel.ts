import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FunctionInfo } from './slitherRunner';
import { getAnnotations, AiOptions, CodeContext } from './aiRunner';
import { getStrings, resolveLang, Strings } from './strings';

type ExpandCallback = (
  functionName: string,
  fromId?: string,
  childId?: string,
  fromContract?: string,
  isSuper?: boolean,
  argCount?: number
) => void;

/** A random CSP nonce for the inline strings script. */
function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/** Escape a string for safe insertion into HTML text/attributes. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Owns the Flowboard WebviewPanel. Singleton: only one flowboard exists at a
 * time, and cards are appended to it rather than spawning new panels.
 */
export class FlowboardPanel {
  public static currentPanel: FlowboardPanel | undefined;

  private static readonly viewType = 'solidityFlowboard';
  private static readonly stateKey = 'solidityFlowboard.state';

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private expandCallback: ExpandCallback | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    this.panel = vscode.window.createWebviewPanel(
      FlowboardPanel.viewType,
      'Solidity Flowboard',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview')]
      }
    );

    this.panel.webview.html = this.loadWebview(context);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        if (!message) {
          return;
        }
        switch (message.type) {
          case 'expand':
            if (this.expandCallback) {
              this.expandCallback(
                message.functionName,
                message.fromId,
                message.childId,
                message.fromContract,
                message.isSuper,
                message.argCount
              );
            }
            break;
          case 'openFile':
            this.openFile(message.fsPath, message.startLine);
            break;
          case 'persist':
            this.context.workspaceState.update(FlowboardPanel.stateKey, message.state);
            break;
          case 'annotate':
            this.annotate(
              message.id,
              message.name,
              message.code,
              message.fsPath,
              message.startLine,
              message.endLine
            );
            break;
          case 'ready': {
            // Always reply so the webview knows restore is done and can begin
            // auto-saving (state may be null when nothing was saved yet).
            const saved = this.context.workspaceState.get(FlowboardPanel.stateKey);
            this.panel.webview.postMessage({ type: 'restore', state: saved ?? null });
            break;
          }
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    FlowboardPanel.currentPanel = this;
  }

  /**
   * Reveal the existing flowboard or create a fresh one (singleton).
   */
  public static createOrShow(
    context: vscode.ExtensionContext,
    reveal = false
  ): FlowboardPanel {
    if (FlowboardPanel.currentPanel) {
      // For an existing panel we do NOT reveal/move it on "Send to Flowboard" -
      // that would change the user's layout (collapse a maximized/expanded
      // panel back to the side). The new card is delivered via postMessage
      // regardless of visibility. Only the explicit "Open Flowboard" command
      // (reveal=true) brings a hidden panel forward, in its own column.
      if (reveal && !FlowboardPanel.currentPanel.panel.visible) {
        const col = FlowboardPanel.currentPanel.panel.viewColumn ?? vscode.ViewColumn.Beside;
        FlowboardPanel.currentPanel.panel.reveal(col, true);
      }
      return FlowboardPanel.currentPanel;
    }
    return new FlowboardPanel(context);
  }

  /**
   * Add a function card. `parentId` draws a connecting line from that card;
   * `id` is the instance id chosen by the webview (omitted for a root card).
   */
  public addFunction(
    info: FunctionInfo,
    code: string,
    parentId?: string,
    id?: string
  ): void {
    this.panel.webview.postMessage({
      type: 'addCard',
      id: id ?? null,
      parentId: parentId ?? null,
      name: info.name,
      code,
      calls: info.calls,
      memberCalls: info.memberCalls ?? [],
      callArity: info.callArity ?? {},
      newCalls: info.newCalls ?? [],
      modifiers: info.modifiers ?? [],
      kind: info.kind ?? null,
      file: path.basename(info.file),
      fsPath: info.file,
      startLine: info.startLine,
      endLine: info.endLine,
      contract: info.contract ?? null,
      notFound: false
    });
  }

  /** Add a placeholder card for a call that could not be resolved in the project. */
  public addMissing(name: string, parentId?: string, id?: string): void {
    this.panel.webview.postMessage({
      type: 'addCard',
      id: id ?? null,
      parentId: parentId ?? null,
      name,
      code: this.strings().notFoundInProject,
      calls: [],
      file: '',
      fsPath: '',
      startLine: 0,
      endLine: 0,
      notFound: true
    });
  }

  /** Open a source file in the editor, revealing the given 1-based line. */
  private openFile(fsPath?: string, startLine?: number): void {
    if (!fsPath) {
      return;
    }
    const uri = vscode.Uri.file(fsPath);
    const line = Math.max(0, (startLine ?? 1) - 1);
    vscode.workspace.openTextDocument(uri).then(
      (doc) => {
        const range = new vscode.Range(line, 0, line, 0);
        vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          selection: range,
          preview: false
        });
      },
      (err) => {
        vscode.window.showErrorMessage(this.strings().errOpenFile + String(err));
      }
    );
  }

  /** The configured UI language setting ("en" | "ru"). */
  private langSetting(): string {
    return vscode.workspace.getConfiguration('solidity-flowboard').get<string>('language', 'en');
  }

  /** The active string set for the configured language. */
  private strings(): Strings {
    return getStrings(this.langSetting());
  }

  /** Read the Claude CLI options from configuration. */
  private aiOptions(): AiOptions {
    const cfg = vscode.workspace.getConfiguration('solidity-flowboard');
    return {
      claudePath: cfg.get<string>('claudePath', 'claude') || 'claude',
      model: cfg.get<string>('model', '') || '',
      codebaseContext: cfg.get<boolean>('codebaseContext', true),
      projectRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      lang: resolveLang(cfg.get<string>('language', 'en'))
    };
  }

  /** Build the file/line context, preferring a path relative to the project root. */
  private makeContext(
    opts: AiOptions,
    fsPath?: string,
    startLine?: number,
    endLine?: number
  ): CodeContext {
    let filePath = fsPath;
    if (fsPath && opts.projectRoot) {
      const rel = path.relative(opts.projectRoot, fsPath);
      if (rel && !rel.startsWith('..')) {
        filePath = rel;
      }
    }
    return { filePath, startLine, endLine };
  }

  /** Generate per-line annotations for a function and send them to the webview. */
  private async annotate(
    id: string,
    name: string,
    code: string,
    fsPath?: string,
    startLine?: number,
    endLine?: number
  ): Promise<void> {
    try {
      const opts = this.aiOptions();
      if (!opts.projectRoot && fsPath) {
        opts.projectRoot = path.dirname(fsPath);
      }
      const ctx = this.makeContext(opts, fsPath, startLine, endLine);
      const { summary, items } = await getAnnotations(code, opts, ctx);
      this.panel.webview.postMessage({ type: 'annotations', id, name, summary, items });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.panel.webview.postMessage({ type: 'aiError', kind: 'annotate', id, name, error });
      vscode.window.showErrorMessage(this.strings().errAnnotate + error);
    }
  }

  /** Register the handler invoked when the user clicks an arrow in the UI. */
  public onExpandCall(callback: ExpandCallback): void {
    this.expandCallback = callback;
  }

  /**
   * Read `webview/index.html` and rewrite asset references to webview URIs.
   */
  public loadWebview(context: vscode.ExtensionContext): string {
    const webviewDir = vscode.Uri.joinPath(context.extensionUri, 'webview');
    const htmlPath = path.join(webviewDir.fsPath, 'index.html');

    const lang = resolveLang(this.langSetting());
    const s = getStrings(lang);
    const w = s.webview;

    let html: string;
    try {
      html = fs.readFileSync(htmlPath, 'utf8');
    } catch {
      return '<html><body><h2>' + s.webviewLoadFailed + '</h2></body></html>';
    }

    // Inline the CSS (not <link>) so html2canvas's render clone keeps the styles.
    let styleContent = '';
    try {
      styleContent = fs.readFileSync(path.join(webviewDir.fsPath, 'style.css'), 'utf8');
    } catch {
      /* ignore - falls back to unstyled */
    }
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'flowboard.js')
    );

    // Cache-bust so the webview never serves a stale script after update.
    const v = Date.now();
    const nonce = makeNonce();
    // Webview strings injected as a global the script reads synchronously.
    const stringsJson = JSON.stringify(w);

    return html
      .replace(/{{cspSource}}/g, this.panel.webview.cspSource)
      .replace(/{{styleContent}}/g, () => styleContent)
      .replace(/{{scriptUri}}/g, scriptUri.toString() + '?v=' + v)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{lang}}/g, lang)
      .replace(/{{stringsJson}}/g, () => stringsJson)
      // Static toolbar / empty-state text: {{t:key}} -> escaped webview string.
      .replace(/{{t:(\w+)}}/g, (_m, key: string) =>
        escapeHtml((w as unknown as Record<string, string>)[key] ?? '')
      );
  }

  public dispose(): void {
    FlowboardPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
