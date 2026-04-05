export async function tcpQuery(host: string, port: number, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          socket.write(`${query}\n`);
        },
        data(_socket, data) {
          buffer += data.toString();
          const newlineIdx = buffer.indexOf("\n");
          if (newlineIdx !== -1) {
            const response = buffer.slice(0, newlineIdx);
            settle(() => resolve(response));
            _socket.end();
          }
        },
        close(_socket) {
          settle(() => reject(new Error("Connection closed before response received")));
        },
        error(_socket, error) {
          settle(() => reject(error));
        },
      },
    }).catch((err: Error) => settle(() => reject(err)));
  });
}
