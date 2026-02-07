
import { ConnectionManager } from '../src/connection-manager';
import ModbusRTU from 'modbus-serial';

jest.mock('modbus-serial');

describe('ConnectionManager', () => {
    let manager: ConnectionManager;
    let mockClient: any;

    beforeEach(() => {
        jest.clearAllMocks();
        
        mockClient = {
            connectTCP: jest.fn().mockResolvedValue(undefined),
            setID: jest.fn().mockResolvedValue(undefined),
            setTimeout: jest.fn(),
            on: jest.fn(),
            close: jest.fn(),
            isOpen: true
        };

        (ModbusRTU as unknown as jest.Mock).mockImplementation(() => mockClient);

        manager = new ConnectionManager();
    });

    afterEach(() => {
        if (manager.cleanupInterval) {
            clearInterval(manager.cleanupInterval);
        }
    });

    test('queues requests sequentially', async () => {
        const order: string[] = [];
        const action1 = jest.fn(async () => {
            order.push('start1');
            await new Promise(r => setTimeout(r, 50));
            order.push('end1');
            return 'result1';
        });
        const action2 = jest.fn(async () => {
            order.push('start2');
            await new Promise(r => setTimeout(r, 10));
            order.push('end2');
            return 'result2';
        });

        // Fire both rapidly
        const p1 = manager.request('127.0.0.1', 502, 1, action1);
        const p2 = manager.request('127.0.0.1', 502, 1, action2);

        await Promise.all([p1, p2]);

        // Expect strict ordering: 1 starts, 1 ends, THEN 2 starts, 2 ends.
        expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
        
        // Should have created only one client
        expect(ModbusRTU).toHaveBeenCalledTimes(1); 
    });

    test('reconnects if client is not open', async () => {
        // First request establishes connection
        await manager.request('127.0.0.1', 502, 1, async () => {});
        expect(mockClient.connectTCP).toHaveBeenCalledTimes(1);

        // Simulate closed connection
        mockClient.isOpen = false;

        // Second request should reconnect (create new client or call connectTCP? 
        // connection-manager.js calls _connect which does `new ModbusRTU()` -> connectTCP.
        // So ModbusRTU constructor should be called again using our mock factory.
        
        await manager.request('127.0.0.1', 502, 1, async () => {});
        
        // _connect creates NEW ModbusRTU instance.
        // ModbusRTU mock returns mockClient each time.
        // So expect connectTCP to be called again.
        expect(mockClient.connectTCP).toHaveBeenCalledTimes(2);
    });

    test('invalidates pool on fatal error', async () => {
        const invalidateSpy = jest.spyOn(manager, 'invalidate');
        const fatalError = new Error('Port Not Open');
        
        // Establish initial connection
        await manager.request('127.0.0.1', 502, 1, async () => {});
        expect(invalidateSpy).not.toHaveBeenCalled();

        // Request that throws fatal error
        try {
            await manager.request('127.0.0.1', 502, 1, async () => {
                throw fatalError;
            });
        } catch (e: any) {
            expect(e.message).toBe('Port Not Open');
        }

        expect(invalidateSpy).toHaveBeenCalledWith('127.0.0.1', 502);
        
        // Next request should trigger new connection
        mockClient.connectTCP.mockClear();
        await manager.request('127.0.0.1', 502, 1, async () => {});
        expect(mockClient.connectTCP).toHaveBeenCalled();
    });

    test('does not invalidate on non-fatal error', async () => {
        const invalidateSpy = jest.spyOn(manager, 'invalidate');
        const nonFatalError = new Error('Some Application Error');
        
        await manager.request('127.0.0.1', 502, 1, async () => {});
        
        try {
            await manager.request('127.0.0.1', 502, 1, async () => {
                throw nonFatalError;
            });
        } catch (e) {
            // expected
        }

        expect(invalidateSpy).not.toHaveBeenCalled();
    });
});
