import { startGroup, endGroup, info } from '@actions/core';

export type Log = (msg: string) => void;

export interface DeployOptions {
  zipPath: string;
  shouldPublish: boolean;
}

/** Structured outcome for one target, used to render the job summary. */
export interface DeployResult {
  target: string;
  /** Human-readable upload status (e.g. `SUCCESS`, `accepted (operation: …)`). */
  upload: string;
  /** Human-readable publish status; undefined when publish was skipped. */
  publish?: string;
}

/**
 * Base class for a deploy target (one browser store). Subclasses implement the
 * three store-specific steps; this class owns the shared orchestration:
 * validate → upload → optionally publish, all wrapped in a log group.
 */
export abstract class DeployTarget {
  constructor(
    readonly name: string,
    protected readonly log: Log = (msg) => info(`[${name}] ${msg}`),
  ) {}

  /** Throws if required inputs/credentials for this target are missing. */
  abstract validate(): void;
  /** Uploads the package to the store's draft; returns an upload status summary. */
  abstract upload(zipPath: string): Promise<string>;
  /** Publishes the current draft; returns a publish status summary. */
  abstract publish(): Promise<string>;

  async run({ zipPath, shouldPublish }: DeployOptions): Promise<DeployResult> {
    startGroup(this.name);
    try {
      this.validate();

      this.log('Uploading extension...');
      const upload = await this.upload(zipPath);

      let publish: string | undefined;
      if (shouldPublish) {
        this.log('Publishing extension...');
        publish = await this.publish();
      } else {
        this.log('Skipping publish (publish=false)');
      }

      return { target: this.name, upload, publish };
    } finally {
      endGroup();
    }
  }
}
