import type { AppReleaseAttrs } from '../models/AppRelease';

/**
 * Version arithmetic for the mobile update prompt.
 *
 * Build numbers are the authority wherever both sides have one: they are plain
 * monotonic integers that the stores already enforce, so there is nothing to get
 * wrong. Version strings are the fallback, compared segment by segment as
 * numbers — "1.0.13" is newer than "1.0.9", which a string comparison gets
 * backwards.
 */

/** -1 when a < b, 0 when equal, 1 when a > b. Missing segments count as 0. */
export function compareVersions(a: string, b: string): number {
  const left = segments(a);
  const right = segments(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function segments(value: string): number[] {
  return value
    .trim()
    // Drop a build suffix such as the "+68" in pubspec's "1.0.13+68".
    .split('+')[0]!
    .split('.')
    .map((part) => {
      const n = Number.parseInt(part.replace(/\D.*$/, ''), 10);
      return Number.isFinite(n) ? n : 0;
    });
}

export interface InstalledApp {
  version: string;
  /** Absent on older builds that only ever sent a version string. */
  build?: number;
}

export interface UpdateDecision {
  updateAvailable: boolean;
  forceUpdate: boolean;
}

/**
 * Whether `installed` is behind the published release, and whether it is so far
 * behind that it must not be allowed to continue.
 *
 * An inactive release, or one the installed build already matches, answers no to
 * both. `forceUpdate` can never be true on its own: being below the minimum
 * implies being below the latest, and the app treats the two as a pair.
 */
export function decideUpdate(
  release: Pick<
    AppReleaseAttrs,
    'latestVersion' | 'latestBuild' | 'minSupportedVersion' | 'minSupportedBuild' | 'isActive'
  >,
  installed: InstalledApp,
): UpdateDecision {
  if (release.isActive === false) return { updateAvailable: false, forceUpdate: false };

  const behind = (target: string | null | undefined, targetBuild: number | null | undefined) => {
    if (typeof targetBuild === 'number' && typeof installed.build === 'number') {
      return installed.build < targetBuild;
    }
    if (!target) return false;
    return compareVersions(installed.version, target) < 0;
  };

  const updateAvailable = behind(release.latestVersion, release.latestBuild);
  if (!updateAvailable) return { updateAvailable: false, forceUpdate: false };

  return {
    updateAvailable: true,
    forceUpdate: behind(release.minSupportedVersion, release.minSupportedBuild),
  };
}
