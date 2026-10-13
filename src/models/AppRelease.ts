import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const APP_PLATFORMS = ['android', 'ios'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/**
 * What the Eplug mobile app should be running, per store.
 *
 * There is exactly one row per platform. Android and iOS are kept apart because
 * their review cycles never land together — iOS can sit in review for days while
 * an Android build is already live — and because each has its own store link.
 *
 * Two thresholds drive the prompt:
 *   latest*        — the newest build in the store. Below it, the driver is
 *                    offered an update they can dismiss.
 *   minSupported*  — the oldest build still allowed to run. Below it, the
 *                    update is forced and the app will not continue without it.
 */
const appReleaseSchema = new Schema(
  {
    platform: { type: String, enum: APP_PLATFORMS, required: true, unique: true },

    latestVersion: { type: String, required: true, trim: true },
    /** Store build number: versionCode on Android, CFBundleVersion on iOS. */
    latestBuild: { type: Number, min: 0 },

    minSupportedVersion: { type: String, trim: true },
    minSupportedBuild: { type: Number, min: 0 },

    /** Where "Шинэчлэх" sends the driver. Play Store and App Store differ. */
    storeUrl: { type: String, required: true, trim: true },

    releaseNotesMn: { type: String, trim: true },
    releaseNotesEn: { type: String, trim: true },

    /**
     * Master switch. Off, the app is told there is nothing to update — the way
     * to stop a prompt that turned out to be wrong without shipping anything.
     */
    isActive: { type: Boolean, default: true },

    updatedBy: { type: String },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret.__v;
        return ret;
      },
    },
  },
);

export type AppReleaseAttrs = InferSchemaType<typeof appReleaseSchema>;
export type AppReleaseDoc = HydratedDocument<AppReleaseAttrs>;

export const AppRelease = model('AppRelease', appReleaseSchema);
