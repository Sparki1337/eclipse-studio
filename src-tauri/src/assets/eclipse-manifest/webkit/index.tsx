import { callable } from '@steambrew/webkit';

type HubcapUsage = {
  used: number;
  limit: number;
  remaining: number;
};

type InstallReply = {
  success: boolean;
  message: string;
  luaCount?: number;
  manifestCount?: number;
  service?: 'ryuu' | 'hubcap';
  configured?: boolean;
  hubcapUsage?: HubcapUsage;
  hubcapUsageError?: string;
  repaired?: boolean;
};

type GameStatusReply = InstallReply & {
  state?: 'available' | 'installed' | 'update_available' | 'repair_required' | 'pending_restart' | 'error' | 'configuration_required';
  cardMode?: 'full' | 'button' | 'crocodile' | 'eclipse';
  theme?: string;
  installed?: boolean;
  updateAvailable?: boolean;
  lastMessage?: string;
  lastTimestamp?: number;
  missingManifestCount?: number;
  restoredManifestCount?: number;
};

type ButtonState = 'idle' | 'loading' | 'success' | 'error' | 'installed' | 'pending';

const installManifest = callable<[{ appid: string; name: string }], string>('install_manifest');
const restartSteam = callable<[], string>('restart_steam');
const getGameStatus = callable<[{ appid: string }], string>('get_game_status');
const restoreManifestCache = callable<[], string>('restore_manifest_cache');

const PANEL_ID = 'eclipse-manifest-panel';
const LEGACY_PANEL_ID = 'crocodile-manifest-panel';
const STYLE_ID = 'eclipse-manifest-style';
const MODAL_ID = 'eclipse-manifest-modal';
let cacheRestoreRunning = false;

// Периодическое фоновое восстановление кэша манифестов
async function keepManifestsAvailable(): Promise<void> {
  if (cacheRestoreRunning) return;
  cacheRestoreRunning = true;
  try {
    await restoreManifestCache();
  } catch {
    // Повтор при следующем фоновом проходе
  } finally {
    cacheRestoreRunning = false;
  }
}

// Извлечение AppID текущей открытой игры из URL или DOM
function currentAppId(): string | null {
  // 1. Из pathname (/app/12345/...)
  const fromPath = window.location.pathname.match(/\/app\/(\d+)/)?.[1];
  if (fromPath) return fromPath;

  // 2. Из query string (?appid=12345)
  const searchParams = new URLSearchParams(window.location.search);
  const fromSearch = searchParams.get('appid') ?? searchParams.get('appId');
  if (fromSearch && /^\d+$/.test(fromSearch)) return fromSearch;

  // 3. Из скрытых полей или метатегов Steam
  const metaAppId = document.querySelector<HTMLInputElement>('input[name="appid"]')?.value
    ?? document.querySelector<HTMLElement>('[data-appid]')?.dataset.appid;
  if (metaAppId && /^\d+$/.test(metaAppId)) return metaAppId;

  return null;
}

// Определение названия текущей игры из заголовка или метатегов
function currentGameName(): string {
  const heading = document.querySelector<HTMLElement>('#appHubAppName')?.textContent?.trim()
    ?? document.querySelector<HTMLElement>('.apphub_AppName')?.textContent?.trim();
  if (heading) return heading;
  const title = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content?.trim();
  if (title) return title.replace(/\s+on Steam$/i, '').trim();
  const docTitle = document.title?.replace(/\s+on Steam$/i, '').trim();
  return docTitle || '';
}

function addStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PANEL_ID}, #${MODAL_ID} .ryuu-modal-card {
      --em-accent: #66c0f4;
      --em-accent-rgb: 102, 192, 244;
      --em-bg: linear-gradient(145deg, rgba(16, 24, 34, .98), rgba(11, 16, 24, .99));
      --em-border: rgba(102, 192, 244, .25);
      --em-glow: rgba(102, 192, 244, .08);
      --em-btn-color: #66c0f4;
      --em-btn-bg: linear-gradient(90deg, rgba(41, 100, 142, .35), rgba(26, 68, 102, .45));
      --em-btn-border: rgba(102, 192, 244, .35);
      --em-btn-hover-bg: linear-gradient(90deg, rgba(41, 100, 142, .6), rgba(26, 68, 102, .7));
      --em-btn-hover-border: rgba(102, 192, 244, .65);
      --em-title-color: #f3f6f8;
      --em-subtitle-color: #8c96a7;
    }
    #${PANEL_ID}[data-theme="oled"], #${MODAL_ID} .ryuu-modal-card[data-theme="oled"] {
      --em-accent: #ffffff;
      --em-accent-rgb: 255, 255, 255;
      --em-bg: linear-gradient(145deg, #050507, #000000);
      --em-border: rgba(255, 255, 255, .18);
      --em-glow: transparent;
      --em-btn-color: #ffffff;
      --em-btn-bg: rgba(255, 255, 255, .08);
      --em-btn-border: rgba(255, 255, 255, .25);
      --em-btn-hover-bg: rgba(255, 255, 255, .16);
      --em-btn-hover-border: rgba(255, 255, 255, .5);
      --em-title-color: #ffffff;
      --em-subtitle-color: #888888;
    }
    #${PANEL_ID}[data-theme="graphite"], #${MODAL_ID} .ryuu-modal-card[data-theme="graphite"] {
      --em-accent: #52ebb5;
      --em-accent-rgb: 82, 235, 181;
      --em-bg: linear-gradient(145deg, rgba(14, 15, 19, .98), rgba(8, 9, 12, .99));
      --em-border: rgba(82, 235, 181, .25);
      --em-glow: rgba(82, 235, 181, .08);
      --em-btn-color: #52ebb5;
      --em-btn-bg: rgba(82, 235, 181, .09);
      --em-btn-border: rgba(82, 235, 181, .32);
      --em-btn-hover-bg: rgba(82, 235, 181, .18);
      --em-btn-hover-border: rgba(82, 235, 181, .6);
      --em-title-color: #f0fdf7;
      --em-subtitle-color: #809a90;
    }
    #${PANEL_ID}[data-theme="steel"], #${MODAL_ID} .ryuu-modal-card[data-theme="steel"] {
      --em-accent: #93a4b8;
      --em-accent-rgb: 147, 164, 184;
      --em-bg: linear-gradient(145deg, rgba(27, 31, 39, .98), rgba(17, 20, 26, .99));
      --em-border: rgba(147, 164, 184, .25);
      --em-glow: rgba(147, 164, 184, .08);
      --em-btn-color: #d2dae4;
      --em-btn-bg: rgba(147, 164, 184, .1);
      --em-btn-border: rgba(147, 164, 184, .3);
      --em-btn-hover-bg: rgba(147, 164, 184, .2);
      --em-btn-hover-border: rgba(147, 164, 184, .55);
      --em-title-color: #f1f5f9;
      --em-subtitle-color: #94a3b8;
    }
    #${PANEL_ID}[data-theme="light"], #${MODAL_ID} .ryuu-modal-card[data-theme="light"] {
      --em-accent: #0284c7;
      --em-accent-rgb: 2, 132, 199;
      --em-bg: linear-gradient(145deg, #f8fafc, #edf2f7);
      --em-border: rgba(0, 0, 0, .14);
      --em-glow: rgba(2, 132, 199, .06);
      --em-btn-color: #0284c7;
      --em-btn-bg: #ffffff;
      --em-btn-border: rgba(2, 132, 199, .35);
      --em-btn-hover-bg: rgba(2, 132, 199, .08);
      --em-btn-hover-border: rgba(2, 132, 199, .65);
      --em-title-color: #0f172a;
      --em-subtitle-color: #475569;
    }
    #${PANEL_ID}[data-theme="ruby"], #${MODAL_ID} .ryuu-modal-card[data-theme="ruby"] {
      --em-accent: #ff5252;
      --em-accent-rgb: 255, 82, 82;
      --em-bg: linear-gradient(145deg, rgba(26, 10, 16, .98), rgba(14, 5, 9, .99));
      --em-border: rgba(255, 82, 82, .25);
      --em-glow: rgba(255, 82, 82, .08);
      --em-btn-color: #ff7575;
      --em-btn-bg: rgba(255, 82, 82, .1);
      --em-btn-border: rgba(255, 82, 82, .32);
      --em-btn-hover-bg: rgba(255, 82, 82, .2);
      --em-btn-hover-border: rgba(255, 82, 82, .6);
      --em-title-color: #fff1f2;
      --em-subtitle-color: #9e7f86;
    }
    #${PANEL_ID}[data-theme="amber"], #${MODAL_ID} .ryuu-modal-card[data-theme="amber"] {
      --em-accent: #ff8c42;
      --em-accent-rgb: 255, 140, 66;
      --em-bg: linear-gradient(145deg, rgba(26, 16, 8, .98), rgba(14, 8, 4, .99));
      --em-border: rgba(255, 140, 66, .25);
      --em-glow: rgba(255, 140, 66, .08);
      --em-btn-color: #ffa466;
      --em-btn-bg: rgba(255, 140, 66, .1);
      --em-btn-border: rgba(255, 140, 66, .32);
      --em-btn-hover-bg: rgba(255, 140, 66, .2);
      --em-btn-hover-border: rgba(255, 140, 66, .6);
      --em-title-color: #fff7ed;
      --em-subtitle-color: #9e8a7c;
    }
    #${PANEL_ID}[data-theme="gold"], #${MODAL_ID} .ryuu-modal-card[data-theme="gold"] {
      --em-accent: #ffc83b;
      --em-accent-rgb: 255, 200, 59;
      --em-bg: linear-gradient(145deg, rgba(24, 20, 8, .98), rgba(12, 10, 4, .99));
      --em-border: rgba(255, 200, 59, .25);
      --em-glow: rgba(255, 200, 59, .08);
      --em-btn-color: #ffd466;
      --em-btn-bg: rgba(255, 200, 59, .1);
      --em-btn-border: rgba(255, 200, 59, .32);
      --em-btn-hover-bg: rgba(255, 200, 59, .2);
      --em-btn-hover-border: rgba(255, 200, 59, .6);
      --em-title-color: #fefce8;
      --em-subtitle-color: #9c947c;
    }
    #${PANEL_ID}[data-theme="forest"], #${MODAL_ID} .ryuu-modal-card[data-theme="forest"] {
      --em-accent: #4ade80;
      --em-accent-rgb: 74, 222, 128;
      --em-bg: linear-gradient(145deg, rgba(10, 20, 16, .98), rgba(5, 11, 9, .99));
      --em-border: rgba(74, 222, 128, .25);
      --em-glow: rgba(74, 222, 128, .08);
      --em-btn-color: #6ee7a0;
      --em-btn-bg: rgba(74, 222, 128, .1);
      --em-btn-border: rgba(74, 222, 128, .32);
      --em-btn-hover-bg: rgba(74, 222, 128, .2);
      --em-btn-hover-border: rgba(74, 222, 128, .6);
      --em-title-color: #f0fdf4;
      --em-subtitle-color: #829a8a;
    }
    #${PANEL_ID}[data-theme="cyan"], #${MODAL_ID} .ryuu-modal-card[data-theme="cyan"] {
      --em-accent: #38d9f5;
      --em-accent-rgb: 56, 217, 245;
      --em-bg: linear-gradient(145deg, rgba(8, 24, 30, .98), rgba(4, 12, 16, .99));
      --em-border: rgba(56, 217, 245, .25);
      --em-glow: rgba(56, 217, 245, .08);
      --em-btn-color: #5fe0f8;
      --em-btn-bg: rgba(56, 217, 245, .1);
      --em-btn-border: rgba(56, 217, 245, .32);
      --em-btn-hover-bg: rgba(56, 217, 245, .2);
      --em-btn-hover-border: rgba(56, 217, 245, .6);
      --em-title-color: #ecfeff;
      --em-subtitle-color: #7b9ba2;
    }
    #${PANEL_ID}[data-theme="midnight"], #${MODAL_ID} .ryuu-modal-card[data-theme="midnight"] {
      --em-accent: #66c0f4;
      --em-accent-rgb: 102, 192, 244;
      --em-bg: linear-gradient(145deg, rgba(16, 24, 34, .98), rgba(11, 16, 24, .99));
      --em-border: rgba(102, 192, 244, .25);
      --em-glow: rgba(102, 192, 244, .08);
      --em-btn-color: #66c0f4;
      --em-btn-bg: linear-gradient(90deg, rgba(41, 100, 142, .35), rgba(26, 68, 102, .45));
      --em-btn-border: rgba(102, 192, 244, .35);
      --em-btn-hover-bg: linear-gradient(90deg, rgba(41, 100, 142, .6), rgba(26, 68, 102, .7));
      --em-btn-hover-border: rgba(102, 192, 244, .65);
      --em-title-color: #f3f6f8;
      --em-subtitle-color: #8c96a7;
    }
    #${PANEL_ID}[data-theme="cosmos"], #${MODAL_ID} .ryuu-modal-card[data-theme="cosmos"] {
      --em-accent: #a77bfe;
      --em-accent-rgb: 167, 123, 254;
      --em-bg: linear-gradient(145deg, rgba(19, 13, 38, .98), rgba(9, 6, 20, .99));
      --em-border: rgba(167, 123, 254, .25);
      --em-glow: rgba(167, 123, 254, .08);
      --em-btn-color: #be9dff;
      --em-btn-bg: rgba(167, 123, 254, .1);
      --em-btn-border: rgba(167, 123, 254, .32);
      --em-btn-hover-bg: rgba(167, 123, 254, .2);
      --em-btn-hover-border: rgba(167, 123, 254, .6);
      --em-title-color: #faf5ff;
      --em-subtitle-color: #9a8ca6;
    }
    #${PANEL_ID}[data-theme="rose"], #${MODAL_ID} .ryuu-modal-card[data-theme="rose"] {
      --em-accent: #f768b7;
      --em-accent-rgb: 247, 104, 183;
      --em-bg: linear-gradient(145deg, rgba(26, 10, 24, .98), rgba(14, 5, 12, .99));
      --em-border: rgba(247, 104, 183, .25);
      --em-glow: rgba(247, 104, 183, .08);
      --em-btn-color: #f988c7;
      --em-btn-bg: rgba(247, 104, 183, .1);
      --em-btn-border: rgba(247, 104, 183, .32);
      --em-btn-hover-bg: rgba(247, 104, 183, .2);
      --em-btn-hover-border: rgba(247, 104, 183, .6);
      --em-title-color: #fdf2f8;
      --em-subtitle-color: #a48293;
    }

    #${PANEL_ID} {
      position: relative;
      isolation: isolate;
      overflow: hidden;
      margin: 0 0 16px;
      padding: 17px;
      border: 1px solid var(--em-border);
      border-radius: 11px;
      background:
        radial-gradient(circle at 0 0, var(--em-glow), transparent 42%),
        var(--em-bg);
      box-shadow:
        0 18px 42px rgba(0, 0, 0, .3),
        inset 0 1px 0 rgba(255, 255, 255, .035);
      font-family: "Motiva Sans", Arial, sans-serif;
    }
    #${PANEL_ID}::before {
      content: "";
      position: absolute;
      z-index: -1;
      inset: 0 auto auto 0;
      width: 100%;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--em-accent), transparent);
      opacity: .7;
    }
    #${PANEL_ID}[data-mode="button"],
    #${PANEL_ID}[data-mode="crocodile"],
    #${PANEL_ID}[data-mode="eclipse"] {
      width: fit-content;
      padding: 0;
      border: 0;
      background: transparent;
      box-shadow: none;
    }
    #${PANEL_ID}[data-mode="button"] {
      min-width: 220px;
    }
    #${PANEL_ID}[data-mode="crocodile"],
    #${PANEL_ID}[data-mode="eclipse"] {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    #${PANEL_ID}[data-mode="button"]::before,
    #${PANEL_ID}[data-mode="button"] .ryuu-header,
    #${PANEL_ID}[data-mode="crocodile"]::before,
    #${PANEL_ID}[data-mode="crocodile"] .ryuu-header,
    #${PANEL_ID}[data-mode="eclipse"]::before,
    #${PANEL_ID}[data-mode="eclipse"] .ryuu-header {
      display: none;
    }
    #${PANEL_ID}[data-mode="button"] .ryuu-button {
      width: auto;
      min-width: 220px;
      height: 38px;
      padding: 0 40px 0 14px;
    }
    #${PANEL_ID}[data-mode="crocodile"] .ryuu-button,
    #${PANEL_ID}[data-mode="eclipse"] .ryuu-button {
      position: relative;
      display: grid;
      place-items: center;
      width: 42px;
      min-width: 42px;
      height: 42px;
      padding: 0;
      border-radius: 10px;
    }
    #${PANEL_ID}[data-mode="crocodile"] .ryuu-button-label,
    #${PANEL_ID}[data-mode="crocodile"] .ryuu-button-arrow,
    #${PANEL_ID}[data-mode="crocodile"] .ryuu-button-icon svg,
    #${PANEL_ID}[data-mode="crocodile"] .ryuu-button-icon::before,
    #${PANEL_ID}[data-mode="eclipse"] .ryuu-button-label,
    #${PANEL_ID}[data-mode="eclipse"] .ryuu-button-arrow,
    #${PANEL_ID}[data-mode="eclipse"] .ryuu-button-icon svg,
    #${PANEL_ID}[data-mode="eclipse"] .ryuu-button-icon::before {
      display: none;
    }
    #${PANEL_ID}[data-mode="crocodile"] .ryuu-button-icon,
    #${PANEL_ID}[data-mode="eclipse"] .ryuu-button-icon {
      position: absolute;
      inset: 0;
      display: grid;
      width: 100%;
      height: 100%;
      place-items: center;
    }
    #${PANEL_ID}[data-mode="crocodile"] .ryuu-button-icon::after,
    #${PANEL_ID}[data-mode="eclipse"] .ryuu-button-icon::after {
      content: "🌒";
      display: grid;
      place-items: center;
      font-family: "Segoe UI Emoji", "Apple Color Emoji", sans-serif;
      font-size: 21px;
      line-height: 1;
    }
    #${PANEL_ID} .ryuu-header {
      display: flex;
      align-items: center;
      gap: 11px;
      margin-bottom: 15px;
    }
    #${PANEL_ID} .ryuu-logo {
      display: grid;
      flex: 0 0 38px;
      width: 38px;
      height: 38px;
      place-items: center;
      border: 1px solid rgba(var(--em-accent-rgb), .3);
      border-radius: 10px;
      color: #fff;
      background: rgba(var(--em-accent-rgb), .12);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .055);
      font-family: "Segoe UI Emoji", "Apple Color Emoji", sans-serif;
      font-size: 21px;
      line-height: 1;
    }
    #${PANEL_ID} .ryuu-copy {
      min-width: 0;
      flex: 1;
    }
    #${PANEL_ID} .ryuu-title {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      margin: 0 0 3px;
      color: var(--em-title-color);
      font-size: 15px;
      font-weight: 650;
      line-height: 1.2;
      letter-spacing: .1px;
    }
    #${PANEL_ID} .ryuu-fork-badge {
      display: inline-block;
      margin-left: 6px;
      font-size: 11px;
      font-weight: 500;
      color: var(--em-accent);
      opacity: .85;
    }
    #${PANEL_ID} .ryuu-subtitle {
      overflow: hidden;
      color: var(--em-subtitle-color);
      font-size: 11.5px;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${PANEL_ID} .ryuu-service-meta {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      width: fit-content;
      max-width: 100%;
      gap: 5px;
      margin: -4px 0 9px auto;
      padding: 4px 7px;
      border: 1px solid rgba(var(--em-accent-rgb), .2);
      border-radius: 999px;
      color: var(--em-subtitle-color);
      background: rgba(var(--em-accent-rgb), .06);
      font-size: 10px;
      line-height: 1;
      white-space: nowrap;
    }
    #${PANEL_ID} .ryuu-service-meta[hidden] {
      display: none;
    }
    #${PANEL_ID} .ryuu-service-name {
      color: var(--em-accent);
      font-weight: 700;
    }
    #${PANEL_ID} .ryuu-service-usage {
      color: #b4bac4;
      font-weight: 650;
    }
    #${PANEL_ID} .ryuu-service-meta[data-error="true"] {
      border-color: rgba(255, 112, 137, .24);
      color: #ff91a5;
      background: rgba(145, 42, 65, .16);
    }
    #${PANEL_ID}[data-mode="button"] .ryuu-service-meta {
      margin: 0 0 6px auto;
    }
    #${PANEL_ID}[data-mode="crocodile"] .ryuu-service-meta,
    #${PANEL_ID}[data-mode="eclipse"] .ryuu-service-meta {
      order: 2;
      margin: 0;
      padding: 4px 7px;
      white-space: nowrap;
    }
    #${PANEL_ID}[data-mode="crocodile"] .ryuu-service-name,
    #${PANEL_ID}[data-mode="eclipse"] .ryuu-service-name {
      display: none;
    }
    #${PANEL_ID} .ryuu-button {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      overflow: hidden;
      width: 100%;
      height: 44px;
      padding: 0 16px;
      border: 1px solid var(--em-btn-border);
      border-radius: 9px;
      color: var(--em-btn-color);
      background: var(--em-btn-bg);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .05);
      font: 650 14px/1 "Motiva Sans", Arial, sans-serif;
      letter-spacing: .1px;
      cursor: pointer;
      transition: color .16s ease, background .16s ease, border-color .16s ease, transform .16s ease, box-shadow .16s ease;
    }
    #${PANEL_ID} .ryuu-button::before {
      display: none;
    }
    #${PANEL_ID} .ryuu-button:hover {
      color: #ffffff;
      border-color: var(--em-btn-hover-border);
      background: var(--em-btn-hover-bg);
      transform: translateY(-1px);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 12px rgba(var(--em-accent-rgb), .25);
    }
    #${PANEL_ID} .ryuu-button:active {
      transform: translateY(0);
      background: var(--em-btn-bg);
    }
    #${PANEL_ID} .ryuu-button:disabled {
      cursor: wait;
      transform: none;
      filter: none;
      opacity: .82;
    }
    #${PANEL_ID} .ryuu-button:disabled[data-state="installed"] {
      cursor: default;
      opacity: 1;
    }
    #${PANEL_ID} .ryuu-button[data-state="success"] {
      border-color: rgba(99, 245, 194, .25);
      color: #82d9bb;
      background: rgba(49, 151, 114, .09);
      box-shadow: none;
    }
    #${PANEL_ID} .ryuu-button[data-state="installed"] {
      border-color: rgba(99, 245, 194, .2);
      color: #75c9aa;
      background: rgba(49, 151, 114, .075);
      box-shadow: none;
    }
    #${PANEL_ID} .ryuu-button[data-state="pending"] {
      border-color: rgba(255, 207, 104, .24);
      color: #d9b87d;
      background: rgba(148, 101, 39, .08);
      box-shadow: none;
    }
    #${PANEL_ID} .ryuu-button[data-state="error"] {
      border-color: rgba(255, 110, 138, .28);
      color: #ee9aad;
      background: rgba(145, 42, 65, .1);
      box-shadow: none;
    }
    #${PANEL_ID} .ryuu-button-icon {
      position: relative;
      z-index: 1;
      display: grid;
      width: 18px;
      height: 18px;
      place-items: center;
    }
    #${PANEL_ID} .ryuu-button-icon svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.8;
    }
    #${PANEL_ID} .ryuu-button[data-state="loading"] .ryuu-button-icon svg,
    #${PANEL_ID} .ryuu-button[data-state="success"] .ryuu-button-icon svg,
    #${PANEL_ID} .ryuu-button[data-state="installed"] .ryuu-button-icon svg,
    #${PANEL_ID} .ryuu-button[data-state="pending"] .ryuu-button-icon svg {
      display: none;
    }
    #${PANEL_ID} .ryuu-button[data-state="loading"] .ryuu-button-icon::before {
      content: "";
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, .35);
      border-top-color: #fff;
      border-radius: 50%;
      animation: ryuu-spin .75s linear infinite;
    }
    #${PANEL_ID} .ryuu-button[data-state="success"] .ryuu-button-icon::before {
      content: "✓";
      color: #fff;
      font-size: 17px;
      font-weight: 800;
    }
    #${PANEL_ID} .ryuu-button[data-state="installed"] .ryuu-button-icon::before {
      content: "✓";
      color: #fff;
      font-size: 17px;
      font-weight: 800;
    }
    #${PANEL_ID} .ryuu-button[data-state="pending"] .ryuu-button-icon::before {
      content: "↻";
      color: #fff;
      font-size: 18px;
      font-weight: 700;
    }
    #${PANEL_ID} .ryuu-button-label {
      position: relative;
      z-index: 1;
    }
    #${PANEL_ID} .ryuu-button-arrow {
      position: absolute;
      z-index: 1;
      right: 15px;
      color: rgba(255, 255, 255, .72);
      font-size: 20px;
      font-weight: 300;
      transition: transform .16s ease;
    }
    #${PANEL_ID} .ryuu-button:hover .ryuu-button-arrow {
      transform: translateX(2px);
    }
    #${PANEL_ID} .ryuu-button:disabled .ryuu-button-arrow {
      opacity: 0;
    }
    @keyframes ryuu-spin {
      to { transform: rotate(360deg); }
    }
    #${MODAL_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(3, 5, 9, .82);
      backdrop-filter: blur(7px);
      animation: ryuu-fade-in .16s ease-out;
    }
    #${MODAL_ID} .ryuu-modal-card {
      position: relative;
      overflow: hidden;
      width: min(440px, calc(100vw - 48px));
      padding: 25px;
      border: 1px solid var(--em-border);
      border-radius: 16px;
      background:
        radial-gradient(circle at 0 0, var(--em-glow), transparent 42%),
        var(--em-bg);
      box-shadow: 0 28px 90px rgba(0, 0, 0, .62), inset 0 1px 0 rgba(255, 255, 255, .04);
      color: #d6d7d8;
      font-family: "Motiva Sans", Arial, sans-serif;
      animation: ryuu-card-in .2s ease-out;
    }
    #${MODAL_ID} .ryuu-modal-card::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--em-accent), transparent);
    }
    #${MODAL_ID} .ryuu-modal-card[data-kind="error"]::before {
      background: linear-gradient(90deg, transparent, rgba(255, 91, 125, .78), transparent);
    }
    #${MODAL_ID} h2 {
      margin: 0 0 10px;
      color: #fff;
      font-size: 20px;
      font-weight: 650;
    }
    #${MODAL_ID} p {
      margin: 0;
      color: #acb2b8;
      font-size: 14px;
      line-height: 1.55;
      white-space: pre-line;
    }
    #${MODAL_ID} .ryuu-modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 22px;
    }
    #${MODAL_ID} button {
      min-width: 110px;
      height: 38px;
      padding: 0 16px;
      border: 1px solid rgba(255, 255, 255, .09);
      border-radius: 9px;
      color: #c8ced6;
      background: rgba(255, 255, 255, .035);
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: transform .15s ease, filter .15s ease, background .15s ease, border-color .15s ease;
    }
    #${MODAL_ID} button:hover { color: #fff; border-color: rgba(var(--em-accent-rgb), .35); background: rgba(var(--em-accent-rgb), .12); transform: translateY(-1px); }
    #${MODAL_ID} button.primary {
      border-color: var(--em-btn-border);
      color: #ffffff;
      background: var(--em-btn-bg);
      box-shadow: 0 0 8px rgba(var(--em-accent-rgb), .25);
    }
    #${MODAL_ID} button.primary:hover {
      filter: brightness(1.15);
      border-color: var(--em-btn-hover-border);
    }
    #${MODAL_ID} button:disabled { cursor: wait; opacity: .6; }
    @keyframes ryuu-fade-in {
      from { opacity: 0; }
    }
    @keyframes ryuu-card-in {
    #${MODAL_ID} button:disabled { cursor: wait; opacity: .6; }
    @keyframes ryuu-fade-in {
      from { opacity: 0; }
    }
    @keyframes ryuu-card-in {
      from { opacity: 0; transform: translateY(8px) scale(.985); }
    }
  `;
  const container = document.head || document.documentElement;
  if (container) {
    container.appendChild(style);
  }
}

function createDownloadIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const arrow = document.createElementNS(ns, 'path');
  arrow.setAttribute('d', 'M12 3v12m0 0 4-4m-4 4-4-4');
  const tray = document.createElementNS(ns, 'path');
  tray.setAttribute('d', 'M5 18v2h14v-2');
  svg.append(arrow, tray);
  return svg;
}

function setButtonState(button: HTMLButtonElement, state: ButtonState, label: string): void {
  button.dataset.state = state;
  const text = button.querySelector<HTMLElement>('.ryuu-button-label');
  if (text) text.textContent = label;
}

function closeModal(): void {
  document.getElementById(MODAL_ID)?.remove();
}

function showMessage(title: string, message: string): void {
  closeModal();
  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;
  const card = document.createElement('div');
  card.className = 'ryuu-modal-card';
  card.dataset.kind = 'error';
  card.dataset.theme = document.getElementById(PANEL_ID)?.dataset.theme || 'midnight';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'ryuu-modal-actions';
  const close = document.createElement('button');
  close.textContent = 'Понятно';
  close.addEventListener('click', closeModal);
  actions.appendChild(close);
  card.append(heading, copy, actions);
  overlay.appendChild(card);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
}

function showRestartPrompt(reply: InstallReply): void {
  closeModal();
  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;
  const card = document.createElement('div');
  card.className = 'ryuu-modal-card';
  card.dataset.kind = 'success';
  card.dataset.theme = document.getElementById(PANEL_ID)?.dataset.theme || 'midnight';
  const heading = document.createElement('h2');
  heading.textContent = 'Манифест получен';
  const copy = document.createElement('p');
  const details = reply.luaCount != null && reply.manifestCount != null
    ? `\nLua-файлов: ${reply.luaCount} · manifest-файлов: ${reply.manifestCount}`
    : '';
  copy.textContent = `${reply.message}${details}\n\nПерезапустить Steam сейчас?`;
  const actions = document.createElement('div');
  actions.className = 'ryuu-modal-actions';
  const later = document.createElement('button');
  later.textContent = 'Нет';
  later.addEventListener('click', closeModal);
  const restart = document.createElement('button');
  restart.className = 'primary';
  restart.textContent = 'Да, перезапустить';
  restart.addEventListener('click', async () => {
    restart.disabled = true;
    later.disabled = true;
    restart.textContent = 'Перезапуск…';
    try {
      const result = JSON.parse(await restartSteam()) as InstallReply;
      if (!result.success) {
        showMessage('Не удалось перезапустить Steam', result.message);
      }
    } catch (error) {
      showMessage('Не удалось перезапустить Steam', String(error));
    }
  });
  actions.append(later, restart);
  card.append(heading, copy, actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

async function handleDownload(button: HTMLButtonElement, appid: string): Promise<void> {
  const panel = button.closest<HTMLElement>(`#${PANEL_ID}`);
  const repairing = button.dataset.gameState === 'repair_required';
  button.disabled = true;
  setButtonState(button, 'loading', 'Получение манифеста…');
  try {
    const reply = JSON.parse(await installManifest({ appid, name: currentGameName() })) as InstallReply;
    if (panel) applyServiceStatus(panel, reply);
    if (!reply.success) {
      showMessage('Не удалось получить манифест', reply.message);
      button.dataset.gameState = 'error';
      setButtonState(button, 'error', 'Повторить загрузку');
      return;
    }
    if (repairing || reply.repaired) {
      button.dataset.gameState = 'installed';
      setButtonState(button, 'installed', 'Уже добавлено');
      showMessage('Манифест восстановлен', 'Файлы возвращены в Steam. Игру можно сразу снова поставить на установку.');
    } else {
      button.dataset.gameState = 'pending_restart';
      setButtonState(button, 'pending', 'Требуется перезапуск Steam');
      showRestartPrompt(reply);
    }
  } catch (error) {
    showMessage('Ошибка плагина', String(error));
    button.dataset.gameState = 'error';
    setButtonState(button, 'error', 'Повторить загрузку');
  } finally {
    button.disabled = false;
    if (panel) void refreshGameStatus(panel, appid, true);
  }
}

function applyServiceStatus(panel: HTMLElement, status: InstallReply): void {
  const meta = panel.querySelector<HTMLElement>('.ryuu-service-meta');
  const usageText = panel.querySelector<HTMLElement>('.ryuu-service-usage');
  if (!meta || !usageText) return;
  const service = status.service || 'ryuu';
  meta.hidden = service !== 'hubcap';
  if (service !== 'hubcap') return;

  if (status.configured === false) {
    meta.dataset.error = 'true';
    usageText.textContent = 'укажите API-ключ';
    meta.title = 'Добавьте личный API-ключ HubCap в настройках Eclipse Manifest';
    return;
  }
  if (status.hubcapUsage) {
    const { used, limit, remaining } = status.hubcapUsage;
    meta.dataset.error = remaining <= 0 ? 'true' : 'false';
    usageText.textContent = `${used}/${limit} · осталось ${remaining}`;
    meta.title = `HubCap: использовано ${used} из ${limit}, осталось ${remaining}`;
    return;
  }
  meta.dataset.error = status.hubcapUsageError ? 'true' : 'false';
  usageText.textContent = status.hubcapUsageError ? 'лимит недоступен' : 'проверка лимита…';
  meta.title = status.hubcapUsageError || 'Получаем дневной лимит HubCap';
}

function applyGameStatus(
  panel: HTMLElement,
  button: HTMLButtonElement,
  subtitle: HTMLElement,
  status: GameStatusReply,
): void {
  panel.dataset.mode = status.cardMode || 'full';
  panel.dataset.theme = status.theme || 'midnight';
  applyServiceStatus(panel, status);
  const gameState = status.state || 'available';
  button.dataset.gameState = gameState;

  if (gameState === 'configuration_required') {
    const serviceName = status.service === 'hubcap' ? 'HubCap' : 'Ryuu';
    subtitle.textContent = `Укажите личный API-ключ ${serviceName} в настройках плагина`;
    button.title = `Требуется API-ключ ${serviceName}`;
    setButtonState(button, 'error', 'Нужен API-ключ');
  } else if (gameState === 'pending_restart') {
    subtitle.textContent = 'Файлы установлены — Steam нужно перезапустить';
    button.title = 'Требуется перезапуск Steam';
    setButtonState(button, 'pending', 'Требуется перезапуск Steam');
  } else if (gameState === 'update_available') {
    subtitle.textContent = 'Для установленного манифеста найдено обновление';
    button.title = 'Обновить манифест';
    setButtonState(button, 'idle', 'Обновить манифест');
  } else if (gameState === 'repair_required') {
    const missing = status.missingManifestCount || 1;
    subtitle.textContent = `Steam удалил manifest-файлы: ${missing}. Их можно вернуть без повторного добавления игры`;
    button.title = 'Восстановить удалённые manifest-файлы';
    setButtonState(button, 'idle', 'Восстановить манифест');
  } else if (gameState === 'installed') {
    subtitle.textContent = status.restoredManifestCount
      ? `Манифест автоматически восстановлен: ${status.restoredManifestCount}`
      : 'Установлена актуальная версия манифеста';
    button.title = 'Уже добавлено';
    setButtonState(button, 'installed', 'Уже добавлено');
  } else if (gameState === 'error') {
    subtitle.textContent = status.lastMessage || 'Предыдущая загрузка завершилась ошибкой';
    button.title = 'Повторить загрузку';
    setButtonState(button, 'error', 'Повторить загрузку');
  } else {
    subtitle.textContent = 'Lua и манифесты прямо из магазина Steam';
    button.title = 'Получить манифест';
    setButtonState(button, 'idle', 'Получить манифест');
  }
  button.disabled = gameState === 'installed' || gameState === 'configuration_required';
}

async function refreshGameStatus(panel: HTMLElement, appid: string, force = false): Promise<void> {
  const lastCheck = Number(panel.dataset.statusChecked || 0);
  if (!force && Date.now() - lastCheck < 4000) return;
  if (panel.dataset.statusLoading === 'true') return;
  const button = panel.querySelector<HTMLButtonElement>('.ryuu-button');
  const subtitle = panel.querySelector<HTMLElement>('.ryuu-subtitle');
  if (!button || !subtitle) return;

  panel.dataset.statusLoading = 'true';
  panel.dataset.statusChecked = String(Date.now());
  try {
    const status = JSON.parse(await getGameStatus({ appid })) as GameStatusReply;
    if (status.success && button.dataset.state !== 'loading') {
      applyGameStatus(panel, button, subtitle, status);
    }
  } catch {
    // Игнорирование сетевых ошибок фоновой проверки
  } finally {
    panel.dataset.statusLoading = 'false';
  }
}

// Поиск оптимального контейнера на странице Steam для вставки карточки манифестов
function findPurchaseArea(): Element | null {
  // 1. Стандартная область покупки игры
  const gameArea = document.querySelector('#game_area_purchase')
    ?? document.querySelector('.game_area_purchase');
  if (gameArea) return gameArea;

  // 2. Родительский контейнер первого блока покупки
  const wrapper = document.querySelector('.game_area_purchase_game_wrapper')
    ?? document.querySelector('.game_area_purchase_game');
  if (wrapper?.parentElement) return wrapper.parentElement;

  // 3. Контейнер опций покупки (новые макеты Steam)
  const options = document.querySelector('#purchaseOptionsContent')
    ?? document.querySelector('.purchase_options_content');
  if (options && options.parentElement) return options.parentElement;

  // 4. Основная левая колонка страницы игры
  const mainCol = document.querySelector('.page_content_ctn .leftcol')
    ?? document.querySelector('.game_page_autocollapse')
    ?? document.querySelector('#tabletGrid .leftcol');
  if (mainCol) return mainCol;

  // 5. Блок действий очереди (желаемое / подписка)
  const queueActions = document.querySelector('#queueActionsCtn')
    ?? document.querySelector('.queue_actions_ctn');
  if (queueActions?.parentElement?.parentElement) {
    return queueActions.parentElement.parentElement;
  }

  return null;
}

// Внедрение плагина на страницу магазина Steam
function injectButton(): void {
  // Удаление устаревшей панели предыдущей версии, если осталась в DOM
  document.getElementById(LEGACY_PANEL_ID)?.remove();

  const appid = currentAppId();
  const existing = document.getElementById(PANEL_ID);
  if (!appid) {
    existing?.remove();
    return;
  }

  const target = findPurchaseArea();
  if (!target) return;

  // Если панель уже на месте в нужном контейнере и для нужного AppID — просто обновляем статус
  if (existing) {
    if (existing.dataset.appid === appid && target.contains(existing)) {
      void refreshGameStatus(existing, appid);
      return;
    }
    existing.remove();
  }

  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.dataset.appid = appid;
  panel.dataset.mode = 'full';
  panel.dataset.theme = 'midnight';
  const header = document.createElement('div');
  header.className = 'ryuu-header';
  const logo = document.createElement('div');
  logo.className = 'ryuu-logo';
  logo.textContent = '🌒';
  const copy = document.createElement('div');
  copy.className = 'ryuu-copy';
  const title = document.createElement('div');
  title.className = 'ryuu-title';
  const titleMain = document.createElement('span');
  titleMain.textContent = 'Eclipse Manifest';
  const titleBadge = document.createElement('span');
  titleBadge.className = 'ryuu-fork-badge';
  titleBadge.textContent = '(форк CrocLua)';
  title.append(titleMain, titleBadge);
  const subtitle = document.createElement('div');
  subtitle.className = 'ryuu-subtitle';
  subtitle.textContent = 'Lua и манифесты прямо из магазина Steam';
  copy.append(title, subtitle);
  header.append(logo, copy);
  const serviceMeta = document.createElement('div');
  serviceMeta.className = 'ryuu-service-meta';
  serviceMeta.hidden = true;
  const serviceName = document.createElement('span');
  serviceName.className = 'ryuu-service-name';
  serviceName.textContent = 'HubCap';
  const serviceUsage = document.createElement('span');
  serviceUsage.className = 'ryuu-service-usage';
  serviceUsage.textContent = 'проверка лимита…';
  serviceMeta.append(serviceName, serviceUsage);
  const button = document.createElement('button');
  button.className = 'ryuu-button';
  button.type = 'button';
  button.dataset.state = 'idle';
  button.dataset.gameState = 'available';
  const icon = document.createElement('span');
  icon.className = 'ryuu-button-icon';
  icon.appendChild(createDownloadIcon());
  const label = document.createElement('span');
  label.className = 'ryuu-button-label';
  label.textContent = 'Получить манифест';
  const arrow = document.createElement('span');
  arrow.className = 'ryuu-button-arrow';
  arrow.textContent = '›';
  button.append(icon, label, arrow);
  button.addEventListener('click', () => {
    if (button.dataset.gameState === 'pending_restart') {
      showRestartPrompt({
        success: true,
        message: 'Файлы уже установлены. Для применения изменений требуется перезапуск Steam.',
      });
      return;
    }
    void handleDownload(button, appid);
  });
  panel.append(header, serviceMeta, button);
  target.prepend(panel);
  void refreshGameStatus(panel, appid, true);
}

// Запуск наблюдателя и таймеров внедрения плагина
function startWebkitInjection(): void {
  addStyles();
  injectButton();

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      injectButton();
    }, 150);
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  window.setInterval(injectButton, 1200);
}

export default async function WebkitMain(): Promise<void> {
  void keepManifestsAvailable();
  window.setInterval((): void => {
    void keepManifestsAvailable();
  }, 2000);

  if (!/^(store\.)?steam(powered|china)\.com$/i.test(window.location.hostname)) return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => startWebkitInjection(), { once: true });
  } else {
    startWebkitInjection();
  }
}
