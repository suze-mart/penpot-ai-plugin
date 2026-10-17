/**
 * Penpot AI Assistant (OpenRouter) — v1.4.2
 * ------------------------------------------
 * ИИ-помощник для Penpot:
 *   - чат-советы по дизайну (модель отвечает текстом в панели);
 *   - генерация макетов по промпту (модель возвращает JSON -> плагин рисует
 *     борды/фигуры/текст прямо на холсте);
 *   - применение палитры к выделению и вставка текста.
 *
 * Архитектура:
 *   - index.html — панель UI (iframe). Она ходит в OpenRouter API напрямую
 *     из браузера (CORS у OpenRouter открыт).
 *   - plugin.js  — этот файл. Обрабатывает сообщения от панели и работает
 *     с холстом через объект `penpot`.
 *
 * Каналы связи:
 *   UI -> plugin: parent.postMessage(msg, "*")          -> penpot.ui.onMessage(...)
 *   plugin -> UI: penpot.ui.sendMessage(msg)            -> window "message" в iframe
 */

penpot.ui.open("AI Assistant (OpenRouter)", "index.html", { width: 640, height: 820 });

penpot.ui.onMessage((message) => {
  if (!message || typeof message !== "object" || !message.type) return;

  switch (message.type) {
    case "plugin-info": {
      sendToUI({
        type: "plugin-info",
        theme: penpot.theme || "dark",
        selection: (penpot.selection || []).length,
      });
      break;
    }

    case "build-design": {
      try {
        const created = buildDesign(message.boards || []);
        sendToUI({ type: "build-result", ok: true, created: created });
      } catch (err) {
        sendToUI({ type: "build-result", ok: false, error: String((err && err.message) || err) });
      }
      break;
    }

    case "apply-palette": {
      try {
        const applied = applyPalette(message.colors || []);
        sendToUI({ type: "palette-result", ok: true, applied: applied });
      } catch (err) {
        sendToUI({ type: "palette-result", ok: false, error: String((err && err.message) || err) });
      }
      break;
    }

    case "insert-text": {
      try {
        const t = penpot.createText(String(message.text || "Text"));
        t.name = "AI Text";
        t.fontId = "gfont-work-sans";
        t.fontSize = "24";
        t.fontWeight = "500";
        positionAtViewport(t);
        t.growType = "auto-width";
        penpot.selection = [t];
        sendToUI({ type: "text-result", ok: true });
      } catch (err) {
        sendToUI({ type: "text-result", ok: false, error: String((err && err.message) || err) });
      }
      break;
    }

    case "create-image": {
      const prompt = String(message.prompt || "AI Image");
      const width = clampNum(message.width || 512, 64, 4096);
      const height = clampNum(message.height || 512, 64, 4096);
      const base64 = message.imageBase64 ? String(message.imageBase64) : "";
      const mime = String(message.mime || "image/jpeg");
      const imgUrl = String(message.imageUrl || "");

      loadImageMedia(prompt, base64, mime, imgUrl)
        .then((media) => {
          const sel = penpot.selection || [];
          if (sel.length > 0 && sel[0].fills) {
            sel[0].fills = [{ fillOpacity: 1, fillImage: media }];
            sendToUI({ type: "image-result", ok: true, mode: "filled" });
          } else {
            const shape = penpot.createRectangle();
            shape.name = "AI: " + prompt.slice(0, 30);
            shape.resize(width, height);
            shape.fills = [{ fillOpacity: 1, fillImage: media }];
            const center = penpot.viewport.center;
            shape.x = center.x - width / 2;
            shape.y = center.y - height / 2;
            penpot.selection = [shape];
            sendToUI({ type: "image-result", ok: true, mode: "created" });
          }
        })
        .catch((err) => {
          sendToUI({ type: "image-result", ok: false, error: String((err && err.message) || err) });
        });
      break;
    }
  }
});

/**
 * Загружает изображение в Penpot.
 * Предпочтительно — из base64-данных (uploadMediaData), без повторного сетевого запроса.
 * Fallback — из URL (uploadMediaUrl) с повторными попытками.
 */
function loadImageMedia(name, base64, mime, url) {
  const mediaName = String(name || "AI Image").slice(0, 32);

  if (base64) {
    try {
      const bytes = base64ToUint8(base64);
      return penpot.uploadMediaData(mediaName, bytes, mime);
    } catch (e) {
      // если декодирование не удалось — пробуем через URL ниже
    }
  }

  if (!url) {
    return Promise.reject(new Error("Нет данных изображения"));
  }
  return retry(function () {
    return penpot.uploadMediaUrl(mediaName, url);
  }, 3, 1500);
}

/** Повторяет вызов функции до `attempts` раз с задержкой `delay` мс. */
function retry(fn, attempts, delay) {
  return fn().catch((err) => {
    if (attempts <= 1) throw err;
    return new Promise((resolve) => setTimeout(resolve, delay))
      .then(() => retry(fn, attempts - 1, delay));
  });
}

/** Преобразует base64 (или data URL) в Uint8Array. */
function base64ToUint8(input) {
  const clean = input.indexOf(",") !== -1 ? input.split(",")[1] : input;
  const bin = atob(clean);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function sendToUI(payload) {
  try {
    penpot.ui.sendMessage(payload);
  } catch (err) {
    // Плагин продолжит работать даже если UI уже закрыт
    console.error("[penpot-ai-plugin] sendMessage failed:", err);
  }
}

/* ------------------------------------------------------------------ */
/* Построение макетов (JSON -> фигуры на холсте)                       */
/* ------------------------------------------------------------------ */

const SPACING_X = 80;

/**
 * Схема от ИИ (строгий JSON):
 * {
 *   "boards": [{
 *     "name": "Login",
 *     "width": 400, "height": 600, "background": "#f8fafc",
 *     "children": [
 *       { "type": "rect",   "name": "Card", "x": 20, "y": 100, "w": 360, "h": 160,
 *         "fill": "#ffffff", "radius": 12 },
 *       { "type": "text",   "name": "Title", "x": 40, "y": 130, "w": 320, "h": 40,
 *         "text": "Войдите в аккаунт", "size": 24, "weight": 700, "align": "left", "color": "#0f172a" },
 *       { "type": "rect",   "name": "Btn", "x": 80, "y": 460, "w": 240, "h": 48,
 *         "fill": "#2563eb", "radius": 8, "label": "Войти", "labelColor": "#ffffff" }
 *     ]
 *   }]
 * }
 */
function buildDesign(boards) {
  const created = [];
  const center = penpot.viewport.center;
  let first = true;
  let cursorX = 0;
  let firstBoard = null;

  for (const b of boards) {
    const x = first ? center.x : cursorX + SPACING_X;
    const y = center.y;
    first = false;

    const w = clampNum(b.width, 240, 2000);
    const h = clampNum(b.height, 160, 2000);

    const board = safeCreateBoard(b.name || "Screen", x, y, w, h);
    if (board) {
      if (b.background) {
        applyFill(board, b.background, null);
      } else {
        // Без фона: убираем белую заливку доски по умолчанию
        try { board.fills = []; } catch (_) { /* ignore */ }
      }
      created.push(board);
      if (!firstBoard) firstBoard = board;
    }

    // Фигуры добавляем ВНУТРЬ доски (appendChild), чтобы двигались вместе с ней
    for (const c of (b.children || [])) {
      const list = createElement(c, board ? board.x : x, board ? board.y : y);
      for (const el of list) {
        if (!el) continue;
        if (board) {
          try { board.appendChild(el); } catch (_) { /* keep on page if nesting unsupported */ }
        }
        created.push(el);
      }
    }

    cursorX = x;
  }

  // Выделяем созданную доску (без группировки — меньше артефактов)
  try {
    penpot.selection = firstBoard ? [firstBoard] : [];
  } catch (_) {
    /* ignore */
  }

  return { shapes: created.length, boards: boards.length };
}

function createElement(c, bx, by) {
  const type = String(c.type || "rect").toLowerCase();
  const x = bx + (c.x || 0);
  const y = by + (c.y || 0);
  const w = clampNum(c.w || c.width, 2, 4000);
  const h = clampNum(c.h || c.height, 2, 4000);
  const out = [];

  // Текст
  if (type === "text") {
    try {
      const t = penpot.createText(String(c.text || c.label || ""));
      t.name = c.name || "Text";
      styleText(t, c);
      t.x = x;
      t.y = y;
      out.push(t);
    } catch (_) {
      /* skip failed text node */
    }
    return out;
  }

  // Фигура
  let shape = null;
  try {
    if (type === "ellipse" || type === "circle") {
      shape = penpot.createEllipse({ name: c.name || "Ellipse", x: x, y: y, width: w, height: h });
    } else {
      shape = penpot.createRectangle({ name: c.name || "Rectangle", x: x, y: y, width: w, height: h });
    }
  } catch (_) {
    return out;
  }

  shape.name = c.name || "Rectangle";
  if (c.fill) {
    applyFill(shape, c.fill, c.opacity);
  } else {
    // Без заливки убираем «белый квадрат» по умолчанию
    try { shape.fills = []; } catch (_) { /* ignore */ }
  }
  if (c.radius != null) {
    try { shape.borderRadius = clampNum(c.radius, 0, 500); } catch (_) { /* ignore */ }
  }
  if (c.stroke) {
    try {
      shape.strokes = [{
        strokeColor: normalizeHex(c.stroke),
        strokeWidth: clampNum(c.strokeWidth || 1, 0, 50),
        strokeStyle: "solid",
        strokeAlignment: "center",
      }];
    } catch (_) { /* ignore */ }
  }
  out.push(shape);

  // Подпись на фигуре (кнопки, карточки)
  if (c.label) {
    try {
      const size = clampNum(c.labelSize || 16, 8, 200);
      const lbl = penpot.createText(String(c.label));
      lbl.name = shape.name + " / label";
      styleText(lbl, {
        size: size,
        weight: c.labelWeight || 600,
        color: c.labelColor || "#ffffff",
        align: "center",
        grow: "auto-width",
      });
      // Центрируем подпись на фигуре (оценка ширины текста), без ресайза в квадрат
      const est = Math.min(w * 0.94, String(c.label).length * size * 0.58);
      lbl.x = x + w / 2 - est / 2;
      lbl.y = y + h / 2 - size * 0.7;
      out.push(lbl);
    } catch (_) { /* ignore */ }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Вспомогательные функции                                             */
/* ------------------------------------------------------------------ */

function styleText(t, c) {
  try {
    // Порядок важен: сначала fontId, потом размер/вес (см. официальный пример create-text)
    t.fontId = "gfont-work-sans";
    if (c.size) t.fontSize = String(c.size);
    if (c.weight) t.fontWeight = String(c.weight);
    if (c.align) t.align = c.align;
    if (c.grow) t.growType = c.grow;
    if (c.color) applyFill(t, c.color, null);
  } catch (_) { /* ignore */ }
}

function applyFill(shape, color, opacity) {
  try {
    const fillColor = normalizeHex(color);
    const fillOpacity = opacity != null ? clampNum(opacity, 0, 1) : undefined;
    shape.fills = fillOpacity != null
      ? [{ fillColor: fillColor, fillOpacity: fillOpacity }]
      : [{ fillColor: fillColor }];
  } catch (_) { /* ignore */ }
}

function safeCreateBoard(name, x, y, w, h) {
  try {
    return penpot.createBoard({ name: name, x: x, y: y, width: w, height: h });
  } catch (_) {
    try {
      const b = penpot.createBoard();
      b.name = name || "Screen";
      b.resize(w, h);
      b.x = x;
      b.y = y;
      return b;
    } catch (_) {
      return null;
    }
  }
}

function positionAtViewport(shape) {
  try {
    const center = penpot.viewport.center;
    shape.x = center.x;
    shape.y = center.y;
  } catch (_) { /* ignore */ }
}

function applyPalette(colors) {
  const sel = penpot.selection || [];
  if (!sel.length) return 0;

  const list = colors.map(normalizeHex);
  sel.forEach((shape, i) => {
    applyFill(shape, list[i % list.length], null);
  });
  return sel.length;
}

function normalizeHex(color) {
  if (typeof color !== "string") return "#000000";
  const c = color.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
  }
  return c;
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}