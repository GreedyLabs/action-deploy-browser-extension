import { startGroup, endGroup, info } from '@actions/core';

export type Log = (msg: string) => void;

export interface DeployOptions {
  zipPath: string;
  shouldPublish: boolean;
}

export abstract class DeployTarget {
  constructor(
    readonly name: string,
    protected readonly log: Log = (msg) => info(`[${name}] ${msg}`),
  ) {}

  abstract validate(): void;
  abstract upload(zipPath: string): Promise<void>;
  abstract publish(): Promise<void>;

  async run({ zipPath, shouldPublish }: DeployOptions): Promise<void> {
    startGroup(this.name);
    try {
      this.validate();

      this.log('Uploading extension...');
      await this.upload(zipPath);

      if (shouldPublish) {
        this.log('Publishing extension...');
        await this.publish();
      } else {
        this.log('Skipping publish (publish=false)');
      }
    } finally {
      endGroup();
    }
  }
}
