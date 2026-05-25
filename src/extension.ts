import * as vscode from 'vscode';
import * as path from 'path';
import {
  runSlither,
  getFunctionCode,
  getEnclosingFunction,
  resolveCall,
  resolveModifiers,
  classifyCalls,
  SlitherResult,
  FunctionInfo
} from './slitherRunner';
import { FlowboardPanel } from './flowboardPanel';
import { getStrings } from './strings';

/** Read the configured UI language ("en" | "ru"). */
function langSetting(): string {
  return vscode.workspace.getConfiguration('solidity-flowboard').get<string>('language', 'en');
}

// Cache the analysis per project root so expanding calls does not re-run Slither.
let cache: { root: string; result: SlitherResult } | undefined;

async function analyze(root: string): Promise<SlitherResult> {
  if (cache && cache.root === root) {
    return cache.result;
  }
  const result = await runSlither(root);
  cache = { root, result };
  return result;
}

/** Resolve a function (contract-aware) and push its card (or a placeholder). */
function pushFunction(
  panel: FlowboardPanel,
  result: SlitherResult,
  name: string,
  parentId?: string,
  id?: string,
  fromContract?: string,
  isSuper?: boolean
): void {
  // Strict: a member/internal call resolves only within the receiver's type +
  // its bases, never to a same-named function in an unrelated contract.
  const info = resolveCall(result, name, fromContract, isSuper, true);
  if (!info) {
    panel.addMissing(name, parentId, id);
    return;
  }
  const code = getFunctionCode(info.file, info.startLine, info.endLine);
  panel.addFunction(info, code, parentId, id);
}

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    'solidity-flowboard.sendToFlowboard',
    async () => {
      const s = getStrings(langSetting());
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage(s.errOpenSolFile);
        return;
      }

      // 1-2. Resolve the exact function under the cursor, including its full body.
      const enclosing = getEnclosingFunction(editor.document, editor.selection.active);
      if (!enclosing) {
        vscode.window.showErrorMessage(s.errCursorNotInFunction);
        return;
      }

      // 3. Project root for analysis.
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      const root = wsFolder
        ? wsFolder.uri.fsPath
        : path.dirname(editor.document.uri.fsPath);

      // 4. Run Slither (cached).
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: s.progressAnalyzing
        },
        () => analyze(root)
      );

      if (!result.slitherAvailable) {
        vscode.window.showErrorMessage(s.errSlitherNotInstalled);
        // Continue anyway: the source-scan index still lets us draw cards.
      }

      // 6. Open (or reveal) the flowboard.
      const panel = FlowboardPanel.createOrShow(context);

      // Wire up arrow clicks -> expand the next function in the flow.
      panel.onExpandCall(
        (name: string, fromId?: string, childId?: string, fromContract?: string, isSuper?: boolean) => {
          pushFunction(panel, result, name, fromId, childId, fromContract, isSuper);
        }
      );

      // 5 + 7. Send the first card using the cursor-precise body. Merge the
      // call list with the project index (which carries Slither-resolved edges).
      // Classify the cursor function's calls against the project index:
      // internal calls + member calls whose receiver type is an in-project contract.
      const cls = classifyCalls(result, enclosing.contract, enclosing.body || '');
      const firstInfo: FunctionInfo = {
        name: enclosing.name,
        file: enclosing.file,
        startLine: enclosing.startLine,
        endLine: enclosing.endLine,
        calls: cls.calls,
        memberCalls: cls.memberCalls,
        modifiers: resolveModifiers(result, enclosing.contract, enclosing.modifierNames),
        contract: enclosing.contract
      };
      const firstCode = getFunctionCode(enclosing.file, enclosing.startLine, enclosing.endLine);
      panel.addFunction(firstInfo, firstCode);
    }
  );

  context.subscriptions.push(disposable);

  // Reopen the (saved) flowboard without first picking a function. The webview
  // restores its previous state via the ready/restore handshake.
  const openCmd = vscode.commands.registerCommand(
    'solidity-flowboard.openFlowboard',
    async () => {
      const panel = FlowboardPanel.createOrShow(context, true);
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (wsFolder) {
        const result = await analyze(wsFolder.uri.fsPath);
        panel.onExpandCall(
          (name: string, fromId?: string, childId?: string, fromContract?: string, isSuper?: boolean) => {
            pushFunction(panel, result, name, fromId, childId, fromContract, isSuper);
          }
        );
      }
    }
  );

  context.subscriptions.push(openCmd);
}

export function deactivate(): void {
  if (FlowboardPanel.currentPanel) {
    FlowboardPanel.currentPanel.dispose();
  }
  cache = undefined;
}
