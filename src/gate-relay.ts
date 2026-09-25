import type { LockState as LockStateValue, Setting } from '@scrypted/sdk';
import http from 'http';
import https from 'https';
import { LockState } from './scrypted-sdk';

interface GateRelayDevice {
    storage: {
        getItem(key: string): string;
    };
    console: Console;
    lockState?: LockStateValue;
}

export class Ds06mGateRelay {
    private autoLockTimer?: NodeJS.Timeout;
    private operation: Promise<void> = Promise.resolve();

    constructor(private device: GateRelayDevice) {
        this.device.lockState = LockState.Locked;
    }

    getSettings(): Setting[] {
        return [
            {
                key: 'openUrl',
                title: 'Open Relay URL',
                value: this.device.storage.getItem('openUrl'),
                type: 'string',
                description: 'HTTP(S) GET URL that activates the DS06M gate relay. Credentials remain in Scrypted storage.',
            },
            {
                key: 'timeoutSeconds',
                title: 'Request Timeout',
                value: Number(this.device.storage.getItem('timeoutSeconds') || 5),
                type: 'number',
                description: 'HTTP request timeout in seconds.',
            },
            {
                key: 'autoLock',
                title: 'Auto Lock',
                value: this.device.storage.getItem('autoLock') !== 'false',
                type: 'boolean',
                description: 'Return the HomeKit lock state to locked after opening.',
            },
            {
                key: 'autoLockDelaySeconds',
                title: 'Auto Lock Delay',
                value: Number(this.device.storage.getItem('autoLockDelaySeconds') || 5),
                type: 'number',
                description: 'Seconds before the HomeKit lock state returns to locked.',
            },
        ];
    }

    async unlock(): Promise<void> {
        clearTimeout(this.autoLockTimer);
        await this.enqueue(async () => {
            await this.requestRelay();
            this.device.lockState = LockState.Unlocked;

            if (this.device.storage.getItem('autoLock') !== 'false') {
                const delaySeconds = this.readPositiveNumber('autoLockDelaySeconds', 5);
                this.autoLockTimer = setTimeout(() => {
                    void this.lock().catch(error => this.device.console.error('DS06M gate lock state update failed', error));
                }, delaySeconds * 1000);
            }
        });
    }

    async lock(): Promise<void> {
        clearTimeout(this.autoLockTimer);
        await this.enqueue(async () => {
            this.device.lockState = LockState.Locked;
        });
    }

    private enqueue(action: () => Promise<void>): Promise<void> {
        const result = this.operation.then(action, action);
        this.operation = result.catch(() => undefined);
        return result;
    }

    private readPositiveNumber(key: string, fallback: number): number {
        const parsed = Number(this.device.storage.getItem(key));
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    private async requestRelay(): Promise<void> {
        const value = this.device.storage.getItem('openUrl')?.trim();
        if (!value)
            throw new Error('Open Relay URL is not configured');

        const target = new URL(value);
        if (target.protocol !== 'http:' && target.protocol !== 'https:')
            throw new Error('Relay URL must use HTTP or HTTPS');

        const timeoutMs = this.readPositiveNumber('timeoutSeconds', 5) * 1000;
        const transport = target.protocol === 'https:' ? https : http;
        const username = decodeURIComponent(target.username);
        const password = decodeURIComponent(target.password);
        target.username = '';
        target.password = '';

        await new Promise<void>((resolve, reject) => {
            const request = transport.request(target, {
                method: 'GET',
                auth: username ? `${username}:${password}` : undefined,
            }, response => {
                response.resume();
                if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300)
                    resolve();
                else
                    reject(new Error(`DS06M relay returned HTTP ${response.statusCode || 'unknown'}`));
            });
            request.setTimeout(timeoutMs, () => request.destroy(new Error('DS06M relay request timed out')));
            request.once('error', reject);
            request.end();
        });
    }
}
