declare module 'zklib' {
  export default class ZKLib {
    constructor(ip: string, port: number, timeout: number, inport: number);
    createSocket(): Promise<boolean>;
    getAttendances(): Promise<{ data: any[] }>;
    getInfo(): Promise<any>;
    disconnect(): Promise<boolean>;
  }
}
