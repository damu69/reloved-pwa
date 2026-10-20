// Runs before the page is drawn so a saved light or dark choice shows from the first frame. A separate file, not an inline script, because the Content-Security-Policy allows scripts from this site only.
try{var t=localStorage.getItem("rl-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}
