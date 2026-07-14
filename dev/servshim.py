
import threading, functools, http.server, socketserver, os
os.chdir('/home/claude/work/dist')
socketserver.TCPServer.allow_reuse_address = True
_h = functools.partial(http.server.SimpleHTTPRequestHandler)
_srv = socketserver.TCPServer(('127.0.0.1', 8901), _h)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
