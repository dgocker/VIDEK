import React, { useEffect, useRef, useState } from 'react';

// Настройки нашего сервера
// В продакшене это будет wss://твое-имя.onrender.com/secure-relay
// Для локальной разработки используем текущий хост
const RELAY_TOKEN = import.meta.env.VITE_RELAY_TOKEN || 'super-secret-anti-dpi-token-2026';

export default function SecureVideoCall() {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const [roomId, setRoomId] = useState('test-room-1');
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Disconnected');
  const [errorMsg, setErrorMsg] = useState('');

  const mimeIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
      if (mimeIntervalRef.current) clearInterval(mimeIntervalRef.current);
    };
  }, []);

  const connectToRelay = () => {
    if (wsRef.current) wsRef.current.close();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const RELAY_SERVER_URL = `${protocol}//${host}/secure-relay`;

    const secureWsUrl = `${RELAY_SERVER_URL}?room=${roomId}&token=${RELAY_TOKEN}`;
    const socket = new WebSocket(secureWsUrl);
    socket.binaryType = 'arraybuffer';
    wsRef.current = socket;

    socket.onopen = () => {
      console.log('Connected to Secure Relay');
      setIsConnected(true);
      setStatusMsg('Connected to Relay');
      setErrorMsg('');
      setupMediaSource(socket);
    };

    socket.onclose = () => {
      console.log('Disconnected from Secure Relay');
      setIsConnected(false);
      setIsStreaming(false);
      setStatusMsg('Disconnected');
    };
    
    socket.onerror = (error) => {
        console.error("WebSocket Error:", error);
        setErrorMsg('WebSocket connection failed. Check console.');
    }
  };

  const setupMediaSource = (socket: WebSocket) => {
    if (!window.MediaSource) {
      setErrorMsg('MediaSource API is not supported in this browser (e.g. older iOS).');
      return;
    }
    const mediaSource = new MediaSource();
    if (remoteVideoRef.current) {
      remoteVideoRef.current.src = URL.createObjectURL(mediaSource);
    }

    mediaSource.addEventListener('sourceopen', () => {
      try {
        // Очередь для пакетов, если буфер занят
        const queue: ArrayBuffer[] = [];
        let isAppending = false;

        const processQueue = () => {
          const sourceBuffer = sourceBufferRef.current;
          if (sourceBuffer && queue.length > 0 && !isAppending && !sourceBuffer.updating) {
            isAppending = true;
            const data = queue.shift();
            if (data) {
                try {
                    sourceBuffer.appendBuffer(data);
                } catch (e) {
                    console.error("Error appending buffer", e);
                    isAppending = false;
                }
            }
          }
        };

        socket.onmessage = async (event) => {
          if (typeof event.data === 'string') {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === 'mime' && msg.mimeType) {
                if (!sourceBufferRef.current) {
                  if (!MediaSource.isTypeSupported(msg.mimeType)) {
                    setErrorMsg(`Remote MimeType ${msg.mimeType} is not supported here.`);
                    return;
                  }
                  try {
                    const sb = mediaSource.addSourceBuffer(msg.mimeType);
                    sourceBufferRef.current = sb;
                    sb.addEventListener('updateend', () => {
                      isAppending = false;
                      processQueue();
                    });
                  } catch (e: any) {
                    console.error("Failed to add source buffer", e);
                    setErrorMsg(`Failed to add source buffer: ${e.message}`);
                  }
                }
              }
            } catch (e) {
              console.error("Error parsing string message", e);
            }
            return;
          }

          if (!sourceBufferRef.current) return; // Wait for mimeType

          // 3. СНИМАЕМ ОБФУСКАЦИЮ (Удаляем мусорный паддинг)
          let unpaddedData: ArrayBuffer;
          try {
            // Если данные пришли как Blob (часто бывает в браузерах)
            if (event.data instanceof Blob) {
              const buffer = await event.data.arrayBuffer();
              unpaddedData = removePadding(buffer);
            } else {
              unpaddedData = removePadding(event.data);
            }
          } catch (e) {
             console.error("Error removing padding", e);
             return;
          }
          
          queue.push(unpaddedData);
          processQueue();
        };
      } catch (e: any) {
        console.error("Error setting up MediaSource", e);
        setErrorMsg('MediaSource error: ' + e.message);
      }
    });
  };

  const startStreaming = async () => {
    try {
      setStatusMsg('Requesting camera...');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const possibleTypes = [
        'video/webm; codecs="vp8, opus"',
        'video/webm; codecs="vp9, opus"',
        'video/webm',
        'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        'video/mp4'
      ];
      
      let mimeType = '';
      for (const type of possibleTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          mimeType = type;
          break;
        }
      }

      if (!mimeType) {
        setErrorMsg(`MediaRecorder does not support any known video types on this browser.`);
        return;
      }

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'mime', mimeType }));
      }
      
      mimeIntervalRef.current = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'mime', mimeType }));
        }
      }, 2000);

      // Нарезаем поток на чанки
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (event) => {
        if (event.data && event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          try {
            const buffer = await event.data.arrayBuffer();
            // 4. ДОБАВЛЯЕМ ОБФУСКАЦИЮ (Мусорные байты для обмана DPI)
            const paddedData = addPadding(buffer);
            wsRef.current.send(paddedData);
          } catch (e) {
            console.error("Error processing video chunk", e);
          }
        }
      };

      // Отправляем чанки каждые 1000мс (1 секунда).
      // На мобильных устройствах слишком частые чанки (200мс) ломают MediaSource
      recorder.start(1000);
      setIsStreaming(true);
      setStatusMsg('Streaming active');
      setErrorMsg('');
    } catch (err: any) {
      console.error('Error accessing media devices:', err);
      setErrorMsg('Camera error: ' + err.message);
    }
  };

  const stopStreaming = () => {
      if (mediaRecorderRef.current) {
          mediaRecorderRef.current.stop();
      }
      if (mimeIntervalRef.current) {
          clearInterval(mimeIntervalRef.current);
          mimeIntervalRef.current = null;
      }
      if (localVideoRef.current && localVideoRef.current.srcObject) {
          const stream = localVideoRef.current.srcObject as MediaStream;
          stream.getTracks().forEach(track => track.stop());
          localVideoRef.current.srcObject = null;
      }
      setIsStreaming(false);
  }

  // --- ФУНКЦИИ ОБФУСКАЦИИ (ANTI-DPI) ---

  // Структура пакета: [4 байта: размер оригинала] + [Оригинальные данные] + [Случайный мусор]
  const addPadding = (originalBuffer: ArrayBuffer) => {
    const originalView = new Uint8Array(originalBuffer);
    const originalSize = originalView.length;
    
    // Генерируем случайный размер мусора от 500 до 5000 байт
    const paddingSize = Math.floor(Math.random() * 4500) + 500; 
    const totalSize = 4 + originalSize + paddingSize;
    
    const paddedBuffer = new ArrayBuffer(totalSize);
    const paddedView = new DataView(paddedBuffer);
    const paddedUint8 = new Uint8Array(paddedBuffer);

    // Пишем размер оригинала в первые 4 байта
    paddedView.setUint32(0, originalSize, true); // true = little-endian
    
    // Копируем оригинальные данные
    paddedUint8.set(originalView, 4);
    
    // Заполняем остаток случайным мусором
    for (let i = 4 + originalSize; i < totalSize; i++) {
      paddedUint8[i] = Math.floor(Math.random() * 256);
    }
    
    return paddedBuffer;
  };

  const removePadding = (paddedBuffer: ArrayBuffer) => {
    const paddedView = new DataView(paddedBuffer);
    // Читаем размер оригинала из первых 4 байт
    const originalSize = paddedView.getUint32(0, true);
    
    // Извлекаем только оригинальные данные, отбрасывая мусор
    return paddedBuffer.slice(4, 4 + originalSize);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-semibold mb-4">Secure Relay Connection</h2>
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Room ID</label>
            <input 
              type="text" 
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              disabled={isConnected}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <button 
            onClick={isConnected ? () => wsRef.current?.close() : connectToRelay}
            className={`px-6 py-2 rounded-lg font-medium text-white transition-colors ${
              isConnected 
                ? 'bg-red-500 hover:bg-red-600' 
                : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            {isConnected ? 'Disconnect' : 'Connect to Relay'}
          </button>
        </div>
        
        {isConnected && (
            <div className="mt-4 pt-4 border-t border-gray-100">
                <button
                    onClick={isStreaming ? stopStreaming : startStreaming}
                    className={`px-6 py-2 rounded-lg font-medium text-white transition-colors ${
                        isStreaming
                            ? 'bg-orange-500 hover:bg-orange-600'
                            : 'bg-emerald-500 hover:bg-emerald-600'
                    }`}
                >
                    {isStreaming ? 'Stop Camera' : 'Start Camera & Stream'}
                </button>
            </div>
        )}

        <div className="mt-4 text-sm">
          <p className="text-gray-600">
            Status: <span className="font-semibold text-gray-900">{statusMsg}</span>
          </p>
          {errorMsg && (
            <p className="text-red-500 font-bold mt-1">
              Error: {errorMsg}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-gray-900 rounded-xl overflow-hidden aspect-video relative shadow-md">
          <div className="absolute top-2 left-2 bg-black/50 text-white px-2 py-1 rounded text-xs z-10">
            Local Camera
          </div>
          <video 
            ref={localVideoRef} 
            autoPlay 
            muted 
            playsInline 
            className="w-full h-full object-cover"
          />
        </div>
        <div className="bg-gray-900 rounded-xl overflow-hidden aspect-video relative shadow-md">
          <div className="absolute top-2 left-2 bg-black/50 text-white px-2 py-1 rounded text-xs z-10 flex items-center gap-2">
            Remote Stream
            <span className="flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-2 w-2 rounded-full opacity-75 ${isConnected ? 'bg-emerald-400' : 'bg-red-400'}`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${isConnected ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
            </span>
          </div>
          <video 
            ref={remoteVideoRef} 
            autoPlay 
            playsInline 
            className="w-full h-full object-cover"
          />
        </div>
      </div>
    </div>
  );
}
