import child_process from 'child_process';
import dgram from 'dgram';
import net, { AddressInfo } from 'net';

export type BoundUdpSocket = { server: dgram.Socket; port: number };

export function bindUdp(port = 0): Promise<BoundUdpSocket> {
    return new Promise((resolve, reject) => {
        const server = dgram.createSocket('udp4');
        const fail = (error: Error) => {
            server.close();
            reject(error);
        };
        server.once('error', fail);
        server.bind(port, () => {
            server.off('error', fail);
            resolve({ server, port: (server.address() as AddressInfo).port });
        });
    });
}

export const createBindZero = () => bindUdp();
export const createBindUdp = (port: number) => bindUdp(port);

export function closeQuiet(socket?: { close: () => unknown }) {
    try {
        socket?.close();
    }
    catch (_) {
    }
}

export function listenZero(server: net.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve((server.address() as net.AddressInfo).port);
        });
    });
}

export function timeoutPromise<T>(timeoutMs: number, promise: Promise<T>): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
}

export function decodeSrtpOptions(encodedOptions: string) {
    const crypto = Buffer.from(encodedOptions, 'base64');
    return { srtpKey: crypto.subarray(0, 16), srtpSalt: crypto.subarray(16, 30) };
}

export function safePrintFFmpegArguments(console: Console, args: string[]) {
    console.log(`ffmpeg ${args.join(' ')}`);
}

export function ffmpegLogInitialOutput(console: Console, cp: child_process.ChildProcess) {
    cp.once('error', error => console.error(error));
}
