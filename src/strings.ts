/** Supported UI languages. */
export type Lang = 'ru' | 'en';

/** Strings rendered inside the webview (JSON-serializable - sent to the webview). */
export interface WebviewStrings {
  // Toolbar
  modeTitle: string;
  modeHand: string;
  modeSelect: string;
  searchTitle: string;
  searchLabel: string;
  linkTitle: string;
  linkLabel: string;
  addNoteTitle: string;
  addNoteLabel: string;
  undoTitle: string;
  undoLabel: string;
  clearTitle: string;
  clearLabel: string;
  emptyState: string;
  // Card
  expand: string; // template with {name}
  annotateLabel: string;
  annotateTitle: string;
  annotating: string;
  metaOpenTitle: string;
  chipOpenTitle: string;
  chipNotFoundTitle: string;
  // Emoji trait badges
  badgeAccess: string;
  badgePayable: string;
  badgeSends: string;
  badgeView: string;
  badgeWrite: string;
  badgeAssembly: string;
  badgeDelegatecall: string;
  badgeLowcall: string;
  badgeStaticcall: string;
  badgeUnchecked: string;
  badgeBlock: string;
  badgeTxorigin: string;
  // Note panel
  noteColorTitle: string;
  noteBgTitle: string;
  noteBoldTitle: string;
  noteSizeTitle: string;
  noteGripTitle: string;
  noteDelTitle: string;
  noteResizeTitle: string;
  notePlaceholder: string;
  // Search
  searchPlaceholder: string;
  subName: string;
  subCode: string;
  note: string;
  searchEmpty: string;
}

/** Prompt fragments + builders for the AI calls (host-only, not serialized). */
export interface PromptStrings {
  contextWhere(filePath: string, startLine?: number, endLine?: number): string;
  contextNote(where: string): string;
  annotations(numberedCode: string, contextNote: string): string;
}

/** The full string set for one language. */
export interface Strings {
  // extension.ts
  errOpenSolFile: string;
  errCursorNotInFunction: string;
  progressAnalyzing: string;
  errSlitherNotInstalled: string;
  // flowboardPanel.ts
  notFoundInProject: string;
  errOpenFile: string; // prefix
  errAnnotate: string; // prefix
  webviewLoadFailed: string;
  // aiRunner.ts (host-side errors)
  aiClaudeNotFound: string;
  aiClaudeTimedOut: string; // template with {s}
  aiClaudeExitCode: string; // template with {code}
  aiParseFailed: string;
  // sub-bundles
  webview: WebviewStrings;
  prompt: PromptStrings;
}

const RU: Strings = {
  errOpenSolFile: 'Открой .sol файл и поставь курсор на функцию.',
  errCursorNotInFunction: 'Курсор не находится внутри функции.',
  progressAnalyzing: 'Solidity Flowboard: анализ Slither...',
  errSlitherNotInstalled: 'Slither не установлен. Установи: pip install slither-analyzer',
  notFoundInProject: 'Функция не найдена в проекте',
  errOpenFile: 'Не удалось открыть файл: ',
  errAnnotate: 'Комментарии к коду не удались: ',
  webviewLoadFailed: 'Не удалось загрузить webview/index.html',
  aiClaudeNotFound: 'Claude CLI не найден. Укажи путь в настройке "solidity-flowboard.claudePath".',
  aiClaudeTimedOut: 'Превышено время ожидания Claude CLI ({s}с)',
  aiClaudeExitCode: 'Claude CLI завершился с кодом {code}',
  aiParseFailed: 'Не удалось разобрать JSON аннотаций из ответа модели',
  webview: {
    modeTitle: 'Режим (клавиша 1): Рука — двигать холст · Выбор — выделять окна рамкой',
    modeHand: '🖐 Рука',
    modeSelect: '▱ Выбор',
    searchTitle: 'Поиск по холсту (Ctrl+F)',
    searchLabel: '🔍 Поиск',
    linkTitle: 'Нарисовать линию: кликни первое окно, затем второе',
    linkLabel: '🔗 Линия',
    addNoteTitle: 'Добавить текстовую заметку',
    addNoteLabel: 'Текст',
    undoTitle: 'Отменить последнее действие (Ctrl+Z)',
    undoLabel: 'Отменить',
    clearTitle: 'Удалить все карточки и заметки',
    clearLabel: 'Очистить',
    emptyState: 'Кликни правой кнопкой на функцию в .sol файле → «Send to Flowboard»',
    expand: 'Раскрыть {name} →',
    annotateLabel: 'Комментарии к коду',
    annotateTitle: 'Построчные пояснения (AI). Повторный клик — скрыть.',
    annotating: 'Комментирую…',
    metaOpenTitle: 'Открыть в редакторе',
    chipOpenTitle: 'Открыть определение модификатора',
    chipNotFoundTitle: 'Определение модификатора не найдено в проекте',
    badgeAccess: 'access control (модификатор / проверка msg.sender)',
    badgePayable: 'принимает средства (payable / transferFrom)',
    badgeSends: 'отправляет средства (transfer / safeTransfer / send / {value:})',
    badgeView: 'view / pure — только чтение',
    badgeWrite: 'изменяет state (storage write)',
    badgeAssembly: 'assembly { } — Yul-блок',
    badgeDelegatecall: 'delegatecall — чужой код в своём контексте',
    badgeLowcall: 'low-level call (произвольные данные)',
    badgeStaticcall: 'staticcall — read-only вызов',
    badgeUnchecked: 'unchecked — без защиты от overflow',
    badgeBlock: 'block.timestamp / block.number',
    badgeTxorigin: 'tx.origin — phishing-вектор',
    noteColorTitle: 'Цвет текста (выделенного фрагмента или всего)',
    noteBgTitle: 'Цвет фона окна',
    noteBoldTitle: 'Жирный (выделенный фрагмент или весь текст)',
    noteSizeTitle: 'Размер шрифта (выделенного фрагмента или всего)',
    noteGripTitle: 'Перетащить',
    noteDelTitle: 'Удалить',
    noteResizeTitle: 'Изменить размер',
    notePlaceholder: 'Текст…',
    searchPlaceholder: 'Поиск по имени функции или коду…',
    subName: 'имя',
    subCode: 'код',
    note: 'заметка',
    searchEmpty: 'Ничего не найдено'
  },
  prompt: {
    contextWhere(filePath, startLine, endLine) {
      return (
        'Функция расположена в файле "' +
        filePath +
        (startLine ? '" (примерно строки ' + startLine + '-' + endLine + ').' : '".')
      );
    },
    contextNote(where) {
      return (
        where +
        ' Ты находишься в корне проекта и можешь читать кодовую базу инструментами Read/Grep/Glob. ' +
        'При необходимости изучи связанный код: определения вызываемых функций, родительские контракты, ' +
        'интерфейсы, библиотеки, константы и инварианты протокола. Анализируй функцию В КОНТЕКСТЕ всего проекта, ' +
        'а не изолированно.\n\n'
      );
    },
    annotations(numberedCode, contextNote) {
      return (
        'Ты — опытный аудитор смарт-контрактов на Solidity. Ниже код функции с номерами строк.\n' +
        contextNote +
        'Верни JSON-объект с двумя полями:\n' +
        '1) "summary" — 1-3 предложения на РУССКОМ: что делает эта функция в целом и зачем она нужна. ' +
        'Это общий обзор всей функции, а НЕ комментарий к строке.\n' +
        '2) "annotations" — массив построчных комментариев на РУССКОМ для КАЖДОЙ значимой строки: что делает строка; ' +
        'если строка важна для безопасности или корректной работы — почему она нужна и почему именно здесь ' +
        '(инварианты, порядок CEI, защита от reentrancy/overflow, граничные случаи).\n' +
        'В annotations НЕ повторяй общий обзор из summary (не описывай функцию целиком под строкой объявления) — ' +
        'комментируй конкретные строки. Не комментируй пустые строки и строки только с "{"/"}". Комментарии краткие.\n' +
        'Формат: {"summary": "<текст>", "annotations": [{"line": <номер>, "comment": "<текст>"}]}. ' +
        'Нумерация строк соответствует коду ниже. Без markdown, без пояснений вокруг.\n\n' +
        'Код функции:\n' +
        numberedCode
      );
    }
  }
};

const EN: Strings = {
  errOpenSolFile: 'Open a .sol file and place the cursor inside a function.',
  errCursorNotInFunction: 'The cursor is not inside a function.',
  progressAnalyzing: 'Solidity Flowboard: running Slither analysis...',
  errSlitherNotInstalled: 'Slither is not installed. Install it: pip install slither-analyzer',
  notFoundInProject: 'Function not found in the project',
  errOpenFile: 'Could not open file: ',
  errAnnotate: 'Code comments failed: ',
  webviewLoadFailed: 'Could not load webview/index.html',
  aiClaudeNotFound: 'Claude CLI not found. Set its path in the "solidity-flowboard.claudePath" setting.',
  aiClaudeTimedOut: 'Claude CLI timed out ({s}s)',
  aiClaudeExitCode: 'Claude CLI exited with code {code}',
  aiParseFailed: 'Could not parse the annotation JSON from the model response',
  webview: {
    modeTitle: 'Mode (key 1): Hand — pan the canvas · Select — marquee-select cards',
    modeHand: '🖐 Hand',
    modeSelect: '▱ Select',
    searchTitle: 'Search the canvas (Ctrl+F)',
    searchLabel: '🔍 Search',
    linkTitle: 'Draw a line: click the first card, then the second',
    linkLabel: '🔗 Line',
    addNoteTitle: 'Add a text note',
    addNoteLabel: 'Note',
    undoTitle: 'Undo the last action (Ctrl+Z)',
    undoLabel: 'Undo',
    clearTitle: 'Delete all cards and notes',
    clearLabel: 'Clear',
    emptyState: 'Right-click a function in a .sol file → “Send to Flowboard”',
    expand: 'Expand {name} →',
    annotateLabel: 'Code comments',
    annotateTitle: 'Per-line explanations (AI). Click again to hide.',
    annotating: 'Commenting…',
    metaOpenTitle: 'Open in editor',
    chipOpenTitle: 'Open the modifier definition',
    chipNotFoundTitle: 'Modifier definition not found in the project',
    badgeAccess: 'access control (modifier / msg.sender check)',
    badgePayable: 'receives funds (payable / transferFrom)',
    badgeSends: 'sends funds (transfer / safeTransfer / send / {value:})',
    badgeView: 'view / pure — read-only',
    badgeWrite: 'modifies state (storage write)',
    badgeAssembly: 'assembly { } — Yul block',
    badgeDelegatecall: 'delegatecall — runs foreign code in this context',
    badgeLowcall: 'low-level call (arbitrary data)',
    badgeStaticcall: 'staticcall — read-only call',
    badgeUnchecked: 'unchecked — no overflow protection',
    badgeBlock: 'block.timestamp / block.number',
    badgeTxorigin: 'tx.origin — phishing vector',
    noteColorTitle: 'Text color (selection or all)',
    noteBgTitle: 'Note background color',
    noteBoldTitle: 'Bold (selection or all text)',
    noteSizeTitle: 'Font size (selection or all)',
    noteGripTitle: 'Drag',
    noteDelTitle: 'Delete',
    noteResizeTitle: 'Resize',
    notePlaceholder: 'Text…',
    searchPlaceholder: 'Search by function name or code…',
    subName: 'name',
    subCode: 'code',
    note: 'note',
    searchEmpty: 'Nothing found'
  },
  prompt: {
    contextWhere(filePath, startLine, endLine) {
      return (
        'The function is located in file "' +
        filePath +
        (startLine ? '" (approximately lines ' + startLine + '-' + endLine + ').' : '".')
      );
    },
    contextNote(where) {
      return (
        where +
        ' You are at the project root and can read the codebase with the Read/Grep/Glob tools. ' +
        'When needed, study related code: definitions of called functions, parent contracts, ' +
        'interfaces, libraries, constants and protocol invariants. Analyze the function IN THE CONTEXT of the whole project, ' +
        'not in isolation.\n\n'
      );
    },
    annotations(numberedCode, contextNote) {
      return (
        'You are an experienced Solidity smart-contract auditor. Below is a function with line numbers.\n' +
        contextNote +
        'Return a JSON object with two fields:\n' +
        '1) "summary" — 1-3 sentences in ENGLISH: what this function does overall and why it exists. ' +
        'This is a high-level overview of the whole function, NOT a per-line comment.\n' +
        '2) "annotations" — an array of per-line comments in ENGLISH for EVERY significant line: what the line does; ' +
        'if the line matters for security or correctness — why it is needed and why exactly here ' +
        '(invariants, CEI order, reentrancy/overflow protection, edge cases).\n' +
        'In annotations do NOT repeat the summary overview (do not describe the whole function under the declaration line) — ' +
        'comment on specific lines. Do not comment empty lines or lines with only "{"/"}". Keep comments short.\n' +
        'Format: {"summary": "<text>", "annotations": [{"line": <number>, "comment": "<text>"}]}. ' +
        'Line numbers match the code below. No markdown, no surrounding prose.\n\n' +
        'Function code:\n' +
        numberedCode
      );
    }
  }
};

const STRINGS: Record<Lang, Strings> = { ru: RU, en: EN };

/**
 * Resolve the active UI language. Default is English; only an explicit `ru`
 * switches to Russian.
 */
export function resolveLang(setting?: string): Lang {
  return setting === 'ru' ? 'ru' : 'en';
}

/** Get the string set for the configured language (reads `solidity-flowboard.language`). */
export function getStrings(setting?: string): Strings {
  return STRINGS[resolveLang(setting)];
}
