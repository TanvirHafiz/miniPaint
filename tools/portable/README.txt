miniPaint AI (portable)
=======================

A layered image editor with AI editing (Generate, Inpaint, Edit, Outpaint, Remove BG, Upscale),
free-form mask tools and layer effects. The AI uses the Runware API with YOUR OWN key.

Requirements: Node.js 18 or newer (https://nodejs.org). Nothing else to install.

Start
  Windows:      double-click start.bat
  Mac / Linux:  ./start.sh      (or: bash start.sh)

The first start creates server/.env. Open it and put your key after RUNWARE_API_KEY=
Get a key at https://runware.ai. Then run the start file again. Your browser opens at
http://localhost:8080

Try it without a key (fake results, free):  start.bat --mock   or   ./start.sh --mock

First time with a real key: AI menu > Diagnose Request Format (costs about $0.001).

Notes
  - Your key stays in server/.env on your computer. It is only sent to api.runware.ai.
  - Costs are shown after every request and as a running total in the bottom left.
  - Change the port: start.bat --port 9000
  - Project page: https://github.com/TanvirHafiz/miniPaint
  - License: MIT (see MIT-LICENSE.txt). Based on miniPaint by Vilius L.
