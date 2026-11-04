===============================================================
  SELF-HOST STARTER — a website that runs from this USB stick
===============================================================

WHAT THIS IS
------------
Everything needed to publish a website from your own hardware:
a web server, your site's files, and a browser-based control
panel you can reach from anywhere.


HOW TO START IT
---------------
Plug this stick into a computer that stays switched on, then:

  Windows   double-click  START-WINDOWS.bat
  macOS     double-click  START-MAC.command
  Linux     run           ./start-linux.sh

Node.js 18 or newer must be installed on that computer.
Get it from https://nodejs.org/ if the launcher says it is missing.

The server prints its web address when it starts. On the very
first run it also prints a generated admin password, and saves
it to data/FIRST-RUN-PASSWORD.txt.


FIRST THINGS TO DO
------------------
  1. Open the admin address shown (ends in /__admin).
  2. Sign in as "admin" with the generated password.
  3. Change that password straight away.
  4. Delete data/FIRST-RUN-PASSWORD.txt.
  5. Edit your pages in the Files tab, or drop your own site
     into the site/ folder on this stick.


IMPORTANT — ABOUT ROUTERS
-------------------------
A Telstra Smart Modem CANNOT run this server. Its USB port only
does file sharing and media streaming; it cannot execute
software. The server must run on a computer on your network,
and the modem forwards internet traffic to that computer.

Full instructions are in docs/02-telstra-router-setup.md in the
project repository.


WHAT IS IN HERE
---------------
  site/     Your website. Everything here is published.
  admin/    The control panel's own files. Leave alone.
  server/   The web server. Leave alone.
  data/     Settings, accounts and logs. Created on first run.


THE FOLDER THAT MATTERS
-----------------------
site/ is your website, published exactly as it sits on disk.
Replace it with your own files and they go live immediately.
No build step, no upload, no deployment.

===============================================================
