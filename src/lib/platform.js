/**
 * 识别当前设备（用于 Landing 下载入口推荐），并给出桌面端安装包的真实下载地址。
 *
 * 安装包发布在桌面端仓库的 GitHub Release 上——和客户端内置的自动更新源是同一个仓库，
 * 所以 Landing 上的下载地址与客户端实际发布的产物天然一致。
 */

export const DESKTOP_RELEASE = {
  repo: 'yunforis/DaylightDesktop',
  tag: 'v0.1.1',
  version: '0.1.1',
};

/** 全部产物清单（含各格式与校验签名）的页面。 */
export const DESKTOP_RELEASES_URL = `https://github.com/${DESKTOP_RELEASE.repo}/releases/tag/${DESKTOP_RELEASE.tag}`;

const VERSION = DESKTOP_RELEASE.version;

/** 拼一个安装包下载地址。指向 Release 里真实存在的产物，浏览器会直接下载安装包本身。 */
export function releaseAssetUrl(name) {
  return `https://github.com/${DESKTOP_RELEASE.repo}/releases/download/${DESKTOP_RELEASE.tag}/${name}`;
}

/** 产物名与 Release 里的实际文件名逐字一致。 */
const ASSET = {
  macArm: `Daylight_${VERSION}_aarch64.dmg`,
  macIntel: `Daylight_${VERSION}_x64.dmg`,
  windowsX64: `Daylight_${VERSION}_x64-setup.exe`,
  windowsArm: `Daylight_${VERSION}_arm64-setup.exe`,
  linuxX64: `Daylight_${VERSION}_amd64.AppImage`,
  linuxArm: `Daylight_${VERSION}_aarch64.AppImage`,
};

export const DOWNLOAD_OPTIONS = [
  { id: 'mac-arm', label: 'macOS（Apple 芯片）', format: 'DMG', group: 'desktop', asset: ASSET.macArm },
  { id: 'mac-intel', label: 'macOS（Intel）', format: 'DMG', group: 'desktop', asset: ASSET.macIntel },
  {
    id: 'windows',
    label: 'Windows',
    format: 'EXE 安装包',
    group: 'desktop',
    assets: { x64: ASSET.windowsX64, arm: ASSET.windowsArm },
  },
  {
    id: 'linux',
    label: 'Linux',
    format: 'AppImage',
    group: 'desktop',
    assets: { x64: ASSET.linuxX64, arm: ASSET.linuxArm },
  },
  { id: 'ios', label: 'iOS', group: 'mobile' },
  { id: 'android', label: 'Android', group: 'mobile' },
  { id: 'harmony', label: '鸿蒙', group: 'mobile' },
];

/** 主入口之外的其它格式（Windows 的 MSI、Linux 的 DEB/RPM），按需下载。 */
export const EXTRA_DOWNLOADS = [
  { label: 'Windows MSI（x64）', asset: `Daylight_${VERSION}_x64_en-US.msi` },
  { label: 'Windows MSI（ARM64）', asset: `Daylight_${VERSION}_arm64_en-US.msi` },
  { label: 'Linux DEB（x64）', asset: `Daylight_${VERSION}_amd64.deb` },
  { label: 'Linux DEB（ARM64）', asset: `Daylight_${VERSION}_arm64.deb` },
  { label: 'Linux RPM（x64）', asset: `Daylight-${VERSION}-1.x86_64.rpm` },
  { label: 'Linux RPM（ARM64）', asset: `Daylight-${VERSION}-1.aarch64.rpm` },
];

function isArm(arch) {
  return /arm|aarch64/i.test(String(arch || ''));
}

/**
 * 某个下载项在当前设备上对应的确切安装包。
 *
 * Windows / Linux 一个条目覆盖双架构，这里按识别到的架构挑 x64 还是 ARM64；
 * 识别不到架构时按 x64（绝大多数机器）——只有明确报 arm 才会给 ARM64 包。
 */
export function desktopDownload(option, arch = '') {
  if (!option || option.group !== 'desktop') return null;
  const name = option.assets ? option.assets[isArm(arch) ? 'arm' : 'x64'] : option.asset;
  if (!name) return null;
  return { url: releaseAssetUrl(name), name, format: downloadFormat(option, arch) };
}

/** 下载项旁显示的格式说明（双架构条目会带上实际架构）。 */
export function downloadFormat(option, arch = '') {
  if (!option?.format) return '';
  if (!option.assets) return option.format;
  return `${option.format} · ${isArm(arch) ? 'ARM64' : 'x64'}`;
}

/** 设备识别结果：`id` 用于推荐项，`arch` 用于在双架构条目里挑对包。 */
export async function detectDevice() {
  if (typeof navigator === 'undefined') return { id: null, arch: '' };
  const arch = await readArchitecture();
  return { id: preferredIdFromUserAgent(arch), arch };
}

function preferredIdFromUserAgent(arch = '') {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';

  if (/HarmonyOS|OpenHarmony|HUAWEI/i.test(ua) && /Mobile|Android/i.test(ua)) return 'harmony';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';

  const isMac = /Mac/i.test(platform) || /Macintosh/i.test(ua);
  // 只有明确读到 x86 才判 Intel Mac（Safari 拿不到架构，按 Apple 芯片处理是当下更常见的情况）。
  if (isMac) return arch === 'x86' ? 'mac-intel' : 'mac-arm';
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
  if ((/Linux/i.test(platform) || /Linux/i.test(ua)) && !/Android/i.test(ua)) return 'linux';
  return null;
}

async function readArchitecture() {
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture']);
      if (architecture) return String(architecture).toLowerCase();
    }
  } catch {
    /* ignore */
  }
  return '';
}
