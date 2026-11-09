/**
 * Port utilities for testing
 * Provides dynamic port allocation to avoid conflicts
 */

import * as net from 'net';

/**
 * Find an available port starting from the given port
 */
export const getAvailablePort = (startPort: number = 3000): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    
    server.listen(startPort, () => {
      const port = (server.address() as net.AddressInfo)?.port;
      server.close(() => {
        resolve(port);
      });
    });
    
    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        // Try next port
        getAvailablePort(startPort + 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
};

/**
 * Get multiple available ports
 */
export const getAvailablePorts = async (count: number, startPort: number = 3000): Promise<number[]> => {
  const ports: number[] = [];
  let currentPort = startPort;
  
  for (let i = 0; i < count; i++) {
    const port = await getAvailablePort(currentPort);
    ports.push(port);
    currentPort = port + 1;
  }
  
  return ports;
};

/**
 * Check if a port is available
 */
export const isPortAvailable = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    server.listen(port, () => {
      server.close(() => {
        resolve(true);
      });
    });
    
    server.on('error', () => {
      resolve(false);
    });
  });
};