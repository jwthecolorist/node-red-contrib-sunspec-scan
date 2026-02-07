declare module 'modbus-serial' {
    export default class ModbusRTU {
        constructor(port?: any);
        connectTCP(ip: string, options?: { port: number }): Promise<void>;
        setID(id: number): Promise<void>;
        setTimeout(duration: number): void;
        readHoldingRegisters(dataAddress: number, length: number): Promise<{ data: number[], buffer: Buffer }>;
        writeRegister(address: number, value: number): Promise<any>;
        writeRegisters(address: number, values: number[] | Buffer): Promise<any>;
        
        on(event: string, callback: (err?: any) => void): void;
        close(callback?: Function): void;
        isOpen: boolean;
    }
}
