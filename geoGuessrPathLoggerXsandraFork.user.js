// ==UserScript==
// @name Fork of xsandra's GeoGuessr Path Logger by echandler v25
// @namespace GeoGuessr
// @description Add a trace of where you have been to GeoGuessr’s results screen
// @version 25
// @include https://www.geoguessr.com/*
// @downloadURL https://github.com/echandler/Fork-of-xsandra-s-GeoGuessr-Path-Logger-script/raw/main/geoGuessrPathLoggerXsandraFork.user.js
// @copyright 2021, xsanda (https://openuserjs.org/users/xsanda)
// @license MIT
// @run-at document-start
// @grant  GM_registerMenuCommand
// @grant  GM_unregisterMenuCommand
// @grant  unsafeWindow
// ==/UserScript==

///////////////// Create Tampermonkey menu button //////////////////////////////////////////////
unsafeWindow.GM_menu = {
    id: null,
    create: function () {
        let state = JSON.parse(localStorage["pathLoggerAnimation"] ?? 1);

        if (GM_menu.id) {
            GM_unregisterMenuCommand(GM_menu.id);
        }

        GM_menu.id = GM_registerMenuCommand(`${state == 1 ? "☑" : "☐"} Auto play Path Logger animation.`, () => {
            localStorage["pathLoggerAnimation"] = !state;
            GM_menu.create();
        });
    },
};

GM_menu.create();

///////////////// Detect google maps scripts //////////////////////////////////////////////

let alertTimer = setTimeout(function () {
    if (!unsafeWindow.google) return;
    alert("Something happened with the GeoGuessr Path Logger script. Reloading the page will probably fix it.");
}, 2000);

const MAPS_API_URL = "https://maps.googleapis.com/maps/api/js?";

window.googleMapsPromise = new Promise((resolve, reject) => {
    try {
        // Watch <head> and <body> for the Google Maps script to be added
        let scriptObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.tagName === "SCRIPT" && node.src.startsWith(MAPS_API_URL)) {
                        // When it’s been added and loaded, load the script below.
                        node.addEventListener("load", () => resolve()); // jshint ignore:line

                        clearTimeout(alertTimer);

                        if (scriptObserver) scriptObserver.disconnect();

                        scriptObserver = undefined;
                    }
                }
            }
        });

        scriptObserver.observe(document.head, {
            childList: true,
        });

        scriptObserver.observe(document.body, {
            childList: true,
        });
    } catch (e) {
        alert("Something happened with the GeoGuessr Path Logger script. Reloading the page will probably fix it.");
        // Promise will not short ciruit if reject is called.
        //reject(e);
    }
}); //.catch(function(reason){
// console.log(reason);
//  });

///////////////// Paste code into page context //////////////////////////////////////////////

function runAsClient(f) {
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.text = "(async () => { try { await (" + f.toString() + ")(); } catch (e) { console.error(e); }})();";
    document.body.appendChild(s);
}

window.runAsClient = runAsClient;

googleMapsPromise.then(() =>
    runAsClient(() => {
        let g_SVObject = null;

        const google = window.google;

        const KEEP_FOR = 1000 * 60 * 60 * 24 * 7; // 1 week

        // Keep a track of stuff added to the map so they can be removed
        let pathStuff = [];

        // Keep a track of whether we are in a round already
        let inGame = false;

        // Keep a track of the current round’s route
        let route = undefined;

        let currentRound = undefined;

        // Keep a track of the start location for the current round, for detecting the return to start button
        let start = undefined;

        let mapState = {};

        //////////////// Modify google maps //////////////////////////////////////////////

        // When a StreetViewPanorama is constructed, add a listener for moving
        const oldSV = google.maps.StreetViewPanorama;
        google.maps.StreetViewPanorama = Object.assign(
            function (...args) {
                g_SVObject = this;
                const res = oldSV.apply(this, args);
                this.addListener("position_changed", () => SVPositionChangedEvent(this));
                return res;
            },
            {
                prototype: Object.create(oldSV.prototype),
            }
        );

        // When a Map is constructed, add a listener for updating
        const oldMap = google.maps.Map;
        google.maps.Map = Object.assign(
            function (...args) {
                const res = oldMap.apply(this, args);
                this.addListener("idle", () => onMapIdleEvent(this));
                return res;
            },
            {
                prototype: Object.create(oldMap.prototype),
            }
        );

        // The geometry API isn’t loaded unless a Street View has been displayed since the last load.
        function loadGeometry() {
            return new Promise((resolve, reject) => {
                const existingScript = document.querySelector("script[src^='https://maps.googleapis.com/maps-api-v3/api/js/']");
                if (!existingScript) reject("No Google Maps loaded yet");
                const libraryURL = existingScript.src.replace(/(.+\/)(.+?)(\.js)/, "$1geometry$3");
                document.head.appendChild(
                    Object.assign(document.createElement("script"), {
                        onload: resolve,
                        type: "text/javascript",
                        src: libraryURL,
                    })
                );
            });
        }

        //////////////// Google maps custom events //////////////////////////////////////////////

        // Handle the street view being navigated
        function SVPositionChangedEvent(sv) {
            try {
                if (!isGamePage()) return;

                const position = getPosition(sv);

                if (!inGame) {
                    // Do nothing if the map is being updated in the background, e.g. on page load while the results are still shown
                    if (resultShown()) return;
                    // otherwise start the round
                    inGame = true;
                    start = position;
                    route = { pathCoords: [], checkPointCoords: [] };
                    currentRound = roundID(); // TODO: Does this fix the bug for challenge links created by someone else (example: links from reddit)?
                    distance = 0;
                } else if (currentRound !== roundID()) {
                    currentRound = roundID();
                    start = position;
                    route = { pathCoords: [], checkPointCoords: [] };
                    distance = 0;
                }

                // If we’re at the start, begin a new trace
                if (position.lat == start.lat && position.lng == start.lng) {
                    route.pathCoords.push([]);
                }

                let currRoute = route.pathCoords[route.pathCoords.length - 1];

                // Calculate how far we have moved (not counting returns-to-start)
                if (currRoute.length > 0) {
                    distance += getDistance(position, currRoute[currRoute.length - 1]);
                }

                // Add the location to the trace
                position.time = Date.now();

                currRoute.push(position);
            } catch (e) {
                console.error("GeoGuessr Path Logger Error:", e);
            }
        }

        function onMapIdleEvent(map_) {
            try {
                if (!isGamePage()) return;

                if (!google.maps.geometry) {
                    loadGeometry().then(() => onMapIdleEvent(map_));
                    return;
                }

                // create a list of the game state indicators, only updating the map when this changes, to save on computation
                const newMapState = {
                    inGame: inGame,
                    resultShown: resultShown(),
                    singleResult: singleResult(),
                    highscoreDetailsVisible: getRoundDistanceContainers().length > 0,
                    roundNumber: roundNumber(),
                };

                if (Object.keys(newMapState).every((key) => mapState[key] === newMapState[key])) return;

                mapState = newMapState;

                // Hide all traces
                pathStuff.forEach((m) => m.forEach((n_) => n_.setMap(null)));
                pathStuff = [];

                // If we’re looking at the results, draw the traces again
                if (resultShown()) {
                    // If we were in a round the last time we checked, then we need to save the route
                    if (inGame) {
                        // encode the route to reduce the storage required.
                        let pathData = getData();

                        if (!pathData[id()]) {
                            pathData[id()] = { rounds: [] };
                        }

                        const encodedRoutes = {
                            p: route.pathCoords,
                            c: route.checkPointCoords,
                        };

                        pathData[id()].rounds[roundNumber()] = encodedRoutes;

                        pathData[id()].t = Date.now();

                        saveData(pathData);

                        setRoundDistance(distance);
                    }

                    inGame = false;

                    // Show all rounds for the current game when viewing the full results
                    let pathData = getData();
                    pathData = pathData[id()];

                    if (singleResult()) {
                        pathData = { rounds: [pathData.rounds[roundNumber()]] };
                    }
                    
                    let rid = id();

                    const roundsToShow = singleResult() ? [roundID()] : [rid +'-1', rid +'-2',rid +'-3',rid +'-4',rid +'-5'];

                    pathStuff = rr(pathData, map_);

                    calculateAndShowDistances(roundsToShow, distance);
                }
            } catch (e) {
                console.error("GeoGuessr Path Logger Error:", e);
            }
        }

        function rr(pathData, map_) {
            let ret = pathData.rounds
                .filter((r) => r) // Ignore missing rounds
                .map((r) => {
                    let _ret = [];

                    const pathCoords = [];

                    _ret.push(
                        r.p
                            .map((_polyline) => {
                                let coords = _polyline; //google.maps.geometry.encoding.decodePath(_polyline);

                                pathCoords.push(coords);

                                let line = new google.maps.Polyline({
                                    path: coords, //google.maps.geometry.encoding.decodePath(polyline),
                                    geodesic: true,
                                    strokeColor: "rebeccapurple", //'#FF0000',
                                    strokeOpacity: 1.0,
                                    strokeWeight: 3,
                                });

                                line._coords = pathCoords;

                                return line;
                            })
                            .flat()
                    );

                    if (r.c) {
                        // Has checkpoints
                        _ret.push(
                            r.c
                                .map((point) => {
                                    //  r.c.map((point) => {
                                    const lineSymbol = {
                                        path: google.maps.SymbolPath.CIRCLE,
                                        scale: 3,
                                        fillColor: "rebeccapurple", // "#669933", //"#566895",
                                        fillOpacity: 0.6,
                                        // strokeColor: "#282c41",
                                        // strokeOpacity: 1,
                                        strokeWeight: 0,
                                    };

                                    return new google.maps.Marker({
                                        position: point,
                                        icon: lineSymbol,
                                    });
                                })
                                .flat()
                        );
                    }

                    if (_ret[0].length === 1 && _ret[0][0]._coords[0].length <= 3) {
                        // Player probably didn't move, maybe photoshere.
                        return [];
                    }

                    _ret = _ret.flatMap((x) => x); // For breakpoint in devtools.

                    return _ret;
                });

            // Add all traces to the map
            ret.forEach((pathOrChkpntArray) => {
                let thisLineAnimation = null;

                pathOrChkpntArray.forEach((pathOrChkpnt) => {
                    let _infoWindow = null;

                    pathOrChkpnt.setMap(map_);

                    pathOrChkpnt.addListener("click", function (e) {
                        console.log(e);
                        if (e.domEvent.shiftKey) {
                            const latLng = { lat: e.latLng.lat(), lng: e.latLng.lng() };
                            const coords = pathOrChkpnt._coords.flat();
                            const loc = coords.reduce((prev, cur) => {
                                const dist1 = prev.dist || Math.sqrt(Math.abs(latLng.lat - prev.lat) ** 2 + Math.abs(latLng.lng - prev.lng) ** 2);
                                const dist2 = Math.sqrt(Math.abs(latLng.lat - cur.lat) ** 2 + Math.abs(latLng.lng - cur.lng) ** 2);

                                return dist1 < dist2 ? { ...prev, dist: dist1 } : { ...cur, dist: dist2 };
                            });

                            setTimeout(function () {
                                // This fixes a problem were "_blank" doesn't open in new tab. Not sure why.
                                window.open(`https://www.google.com/maps?q&layer=c&cbll=${loc.lat},${loc.lng}`, "_blank");
                            }, 1);

                            return;
                        }

                        makeLineAnimation.call(null, true);
                    });

                    pathOrChkpnt.addListener("mouseover", function (e) {
                        if (_infoWindow !== null) return;

                        _infoWindow = setTimeout(function () {
                            const state = JSON.parse(localStorage["pathLoggerAnimation"] ?? 1);

                            const d = document.createElement("div");
                            d.style.cssText = "color:black; font-size: 1.2em;";
                            d.innerHTML = `<span>Click line to start animation.</span><br>
                                                        <span>Press "[" or "]" to change speed.</span><br>
                                                        <span>Hold shift key and click on line to open nearest point in Google Maps.</span>
                                        `;

                            const btnContainer = document.createElement("div");
                            d.appendChild(btnContainer);

                            const btn = document.createElement("button");
                            btn.style.cssText = "margin-top: 1em; margin-right: 1em;";
                            btn.onclick = function (e) {
                                localStorage["pathLoggerAnimation"] = !JSON.parse(localStorage["pathLoggerAnimation"] ?? 1);
                                btn.innerText = JSON.parse(localStorage["pathLoggerAnimation"] ?? 1) == 1 ? "Turn auto play off" : "Turn auto play on";
                                GM_menu.create();
                            };

                            btn.innerText = state == 1 ? "Turn auto play off" : "Turn auto play on";
                            btnContainer.appendChild(btn);

                            const pathData = getData();
                            const isUploaded = pathData[id()].uploaded === true;

                            const fireBaseUrl = "https://pathloggerapi-default-rtdb.firebaseio.com/games/";

                            const uploadBtn = document.createElement("button");
                            uploadBtn.innerText = isUploaded ? "View game traces" : "Upload game traces";
                            uploadBtn.style.cssText = "margin-top: 1em;";

                            btnContainer.appendChild(uploadBtn);

                            uploadBtn.disabled = singleResult() || !isChallenge() ? true : false;

                            uploadBtn.addEventListener("click", isUploaded ? clickViewTraces : clickUploadTraces);

                            async function clickViewTraces() {
                                uploadBtn.disabled = true;

                                _infoWindow.setMap(null);
                                _infoWindow = null;

                                let list = await fetch(fireBaseUrl + id() + ".json?shallow=true").then((res) => res.json());

                                let menu = createMenu();

                                if (!menu) return;

                                const refreshBtn = document.createElement("button");
                                refreshBtn.innerText = "Refresh";
                                refreshBtn.style.cssText = "display: block; margin: 0px auto; width: fit-content; cursor: pointer;";
                                refreshBtn.addEventListener("click", async function () {
                                    let list1 = await fetch(fireBaseUrl + id() + ".json?shallow=true").then((res) => res.json());
                                    //menu.container.parentElement.removeChild(menu.container);
                                    for (let playerName in list1) {
                                        if (playerName === "t_i_m_e" || list[playerName]) continue;

                                        list[playerName] = true;
                                        makeLi(playerName);
                                    }
                                });

                                menu.header.innerHTML = "";
                                menu.header.appendChild(refreshBtn);

                                let ul = document.createElement("ul");
                                ul.style.cssText = "margin: 10px; padding-left: 0px; list-style: none;";
                                ul._highlighted = null;

                                for (let playerName in list) {
                                    if (playerName === "t_i_m_e") continue;
                                    makeLi(playerName);
                                }

                                menu.body.appendChild(ul);

                                function makeLi(playerName) {
                                    const li = document.createElement("LI");
                                    li.innerHTML = playerName;
                                    li.style.cssText = "padding: 10px; cursor: pointer;width: fit-content; margin: 0px auto;";
                                    ul.appendChild(li);

                                    li.addEventListener("click", async function () {
                                        if (ul._highlighted === li) return;

                                        let coords = li._coords || (await fetch(fireBaseUrl + id() + "/" + playerName + ".json").then((res) => res.json()));

                                        if (!li._coords) {
                                            li._coords = coords;
                                        }

                                        if (ul._highlighted) {
                                            ul._highlighted.style.backgroundColor = "";
                                        }

                                        li.style.backgroundColor = "yellow";

                                        ul._highlighted = li;

                                        ret.forEach((m) => m.forEach((n_) => n_.setMap(null)));

                                        rr({ rounds: coords }, map_);
                                    });
                                }
                                // menu.body.innerHTML = Object.keys(list);
                            }

                            async function clickUploadTraces() {
                                uploadBtn.disabled = true;
                                _infoWindow.setMap(null);
                                _infoWindow = null;

                                const pathData = getData();

                                if (pathData[id()].uploaded === true) {
                                    alert("Traces has alread been uploaded.");
                                    // return;
                                }

                                //       const roundsToShow = singleResult() ? [roundID()] : Object.keys(pathData).filter((map) => map.startsWith(id()));

                                const savedName = localStorage["pathloggerName"] || "";
                                const playerName = prompt("Enter name you would like displayed to other players:", savedName);

                                if (!playerName) {
                                    alert("Please try again.");
                                    return;
                                }

                                if (playerName.length > 20) {
                                    alert("Name needs to be less than 20 characters.");
                                    return;
                                }

                                const checkName = await fetch(fireBaseUrl + id() + "/" + playerName + ".json")
                                    .then((res) => res.json())
                                    .catch((error) => {
                                        console.error(error);
                                        return { error: error };
                                    });

                                if (checkName != null || checkName?.error) {
                                    alert("Try a different name. However, there may be a problem with the database, but probably not.");

                                    if (checkName.error) alert(checkName.error);

                                    return;
                                }

                                localStorage["pathloggerName"] = playerName;

                                let requestOptions = {
                                    method: "PATCH",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                        [playerName]: pathData[id()].rounds,
                                        t_i_m_e: Date.now(),
                                    }),
                                };

                                fetch(fireBaseUrl + id() + ".json", requestOptions)
                                    .then((response) => response.json())
                                    .then((json) => console.log(json))
                                    .catch((error) => alert(error));

                                pathData[id()].uploaded = true;

                                saveData(pathData);
                            }

                            d.addEventListener("mousedown", () => {
                                // Infowindows don't "do" mousedown events.
                                let removeInfoWindowEvent = map_.addListener("idle", function () {
                                    if (_infoWindow) {
                                        _infoWindow.setMap(null);
                                        _infoWindow = null;
                                    }
                                    google.maps.event.removeListener(removeInfoWindowEvent);
                                });

                                clearTimeout(p);
                            });

                            _infoWindow = new google.maps.InfoWindow({
                                content: d,
                                position: e.latLng,
                            });

                            _infoWindow.open(map_);

                            _infoWindow.addListener("closeclick", function () {
                                _infoWindow = null;
                            });

                            let p = setTimeout(() => {
                                _infoWindow.close();
                                _infoWindow = null;
                            }, 5000);
                        }, 2000);
                    });

                    pathOrChkpnt.addListener("mouseout", function (e) {
                        clearTimeout(_infoWindow);
                        if (typeof _infoWindow === "number") _infoWindow = null;
                    });

                    const oldPolyLineSetMap = pathOrChkpnt.setMap;
                    pathOrChkpnt.setMap = function () {
                        if (thisLineAnimation) {
                            thisLineAnimation.clear();
                            thisLineAnimation = null;
                        }
                        oldPolyLineSetMap.apply(pathOrChkpnt, arguments);
                    };

                    if (!thisLineAnimation && JSON.parse(localStorage["pathLoggerAnimation"] ?? 1)) {
                        makeLineAnimation();
                    }

                    function makeLineAnimation(startAnimationNow) {
                        let animationMultiplier = 1;

                        if (thisLineAnimation) {
                            thisLineAnimation.clear();
                            thisLineAnimation = null;
                            document.body.removeEventListener("keypress", _keypress);
                            return;
                        }

                        const createAnimatedMarkerTimer = setTimeout(
                            function (pathOrChkpnt, animationMultiplier, map_) {
                                // Wait for the map to finish between rounds before animating.
                                thisLineAnimation = createAnimatedMarker(pathOrChkpnt._coords, animationMultiplier, map_);
                                markerListener();
                            },
                            startAnimationNow ? 1 : 2000,
                            pathOrChkpnt,
                            animationMultiplier,
                            map_
                        );

                        thisLineAnimation = {
                            clear: function () {
                                clearTimeout(createAnimatedMarkerTimer);
                            },
                        };

                        document.body.addEventListener("keypress", _keypress);

                        function _keypress(e) {
                            if (e.key === "]") {
                                animationMultiplier *= 2;
                                thisLineAnimation.clear();
                                thisLineAnimation = createAnimatedMarker(pathOrChkpnt._coords, animationMultiplier, map_);
                                markerListener();
                            } else if (e.key === "[") {
                                animationMultiplier /= 2;
                                thisLineAnimation.clear();
                                thisLineAnimation = createAnimatedMarker(pathOrChkpnt._coords, animationMultiplier, map_);
                                markerListener();
                            }
                        }

                        function markerListener() {
                            thisLineAnimation.marker.addListener("click", function () {
                                thisLineAnimation.clear();
                                thisLineAnimation = null;
                                document.body.removeEventListener("keypress", _keypress);
                            });
                        }
                    }
                });
            });

            return ret;
        }
        function createAnimatedMarker(pathCoords_, multiplier_, map_) {
            const lineSymbol = {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 8,
                fillColor: "#669933", //"#566895",
                fillOpacity: 1,
                // strokeColor: "#282c41",
                // strokeOpacity: 1,
                strokeWeight: 0,
            };

            const marker = new google.maps.Marker({
                draggable: true,
                map: map_,
                icon: lineSymbol,
            });

            marker.addListener("drag", handleEventDrag);
            marker.addListener("dragend", handleEventDragEnd);

            function handleEventDrag(e) {
                cancelAnimation = true;
            }

            function handleEventDragEnd(e) {
                let lat = e.latLng.lat();
                let lng = e.latLng.lng();
                let d = 99999999999;
                let p = 0;

                for (let n = 0; n < frames.length; n++) {
                    const dist = Math.sqrt(Math.abs(lat - frames[n].lat) ** 2 + Math.abs(lng - frames[n].lng) ** 2);

                    if (dist < d) {
                        d = dist;
                        p = n;
                    }
                }

                frameIdx = p;
                cancelAnimation = false;
                requestAnimationFrame(animationCallback);
            }

            pathCoords_ = pathCoords_.flatMap((x) => x);

            const frames = [];

            let from = pathCoords_[0];

            for (let n = 1; n < pathCoords_.length; n++) {
                // One frame = one set of lat lng coords.

                const to = pathCoords_[n];

                let incs = (to.time - from.time - 1000) /*milliseconds*/ / multiplier_ / (1000 / 60); /*16 frames per second*/
                incs = incs > 150 / multiplier_ ? 150 / multiplier_ : Math.ceil(incs); // 150 frames should be about 2500ms.

                // Make the animation run faster at the beginning.
                if (frames.length < (16 / multiplier_) * 2 + 20 * 2) incs = 20;

                for (let m = 0; m < incs; m++) {
                    // Each frame will be same position so that it will look like the
                    // animation is pausing where the player stopped and looked around.
                    frames.push({ lat: from.lat, lng: from.lng, wait: true });
                }

                incs = Math.ceil(16 / multiplier_);

                for (let m = 0; m < incs + 1; m++) {
                    // Calculate frames to move from one point to next.
                    const curLat = from.lat + (m / incs) * (to.lat - from.lat);
                    const curLng = from.lng + (m / incs) * (to.lng - from.lng);
                    frames.push({ lat: curLat, lng: curLng });
                }

                from = to;
            }

            frames[0].wait = false; // Make sure first frame shows marker in animation.

            let frameIdx = 0;
            let cancelAnimation = false;

            function animationCallback() {
                if (frameIdx >= frames.length) {
                    frameIdx = 0;

                    setTimeout(() => {
                        // Pause at end then go to start.
                        marker.setPosition(frames[frameIdx++]);
                        setTimeout(() => requestAnimationFrame(animationCallback), 600);
                    }, 2500);

                    return;
                }

                if (!frames[frameIdx].wait) {
                    marker.setPosition(frames[frameIdx]);
                }

                frameIdx++;

                if (!cancelAnimation) {
                    requestAnimationFrame(animationCallback);
                }
            }

            requestAnimationFrame(animationCallback);

            return {
                clear: () => {
                    marker.setMap(null);
                    cancelAnimation = true;
                },
                marker: marker,
            };
        }

        //////////////// GeoGuessr buttons custom events //////////////////////////////////////////////

        setInterval(function () {
            // Run forever.
            makeGeoGuessrButtonListeners();
        }, 1000);

        function makeGeoGuessrButtonListeners() {
            const undoBtn = document.querySelector('button[data-qa="undo-move"]');
            const checkPointBtn = document.querySelector('button[data-qa="set-checkpoint"]');

            if (!checkPointBtn || checkPointBtn._state !== undefined) return;

            checkPointBtn._state = 0;

            checkPointBtn.addEventListener("click", function (e) {
                checkPointBtn._state = checkPointBtn._state === 1 ? 0 : 1;
                if (checkPointBtn._state === 1) {
                    const r = route.pathCoords[route.pathCoords.length - 1];
                    const coord = r.pop();
                    r.push(coord);
                    route.pathCoords.push([coord]);
                    route.checkPointCoords.push(coord);
                    return;
                } else {
                    // Probably will have two identical points to fix minor bug.
                    const a = [route.checkPointCoords[route.checkPointCoords.length - 1]];
                    route.pathCoords.push(a);
                }
            });

            undoBtn.addEventListener("click", function (e) {
                route.pathCoords.push([]);
            });
        }

        //////////////// Clean up localStorage //////////////////////////////////////////////

        // Remove all games older than a week
        function clearOldGames() {
            let pathData = getData();
            let keys = Object.keys(pathData);

            // Delete all games older than a week
            const cutoff = Date.now() - KEEP_FOR;
            for (const [gameID, data] of Object.entries(pathData)) {
                if (data.t < cutoff) {
                    delete pathData[gameID];
                }
            }

            saveData(pathData);
        }

        setTimeout(clearOldGames, 5000); // Old data may be needed by some other function possibly.

        //////////////// Thanks to enigma_mf for distance calculating code. //////////////////
        //////////////// https://discord.com/channels/730647011497607220/949511589365678120/1031334161664979055

        // Keep a running total of the distance traveled on the current round.
        let distance;

        // Calculate the distance between two points
        // I think I pulled this from an SO article

        const rad = function (x) {
            return (x * Math.PI) / 180;
        };

        const getDistance = function (p1, p2) {
            const R = 6378137; // Earth’s mean radius in meters
            const dLat = rad(p2.lat - p1.lat);
            const dLong = rad(p2.lng - p1.lng);
            const angle = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rad(p1.lat)) * Math.cos(rad(p2.lat)) * Math.sin(dLong / 2) * Math.sin(dLong / 2);
            return 2 * R * Math.atan2(Math.sqrt(angle), Math.sqrt(1 - angle));
        };

        // Record the distance traveled during a round
        const setRoundDistance = (distance) => {
            const distances = JSON.parse(localStorage.distances || "{}");
            distances[roundID()] = distance;
            localStorage.distances = JSON.stringify(distances);
        };

        // Get the recorded distance for the given roundID
        const getRoundDistance = (key) => {
            const distances = JSON.parse(localStorage.distances || "{}");
            return parseFloat(distances[key]);
        };

        // Find the round detail cell on the challenge highscore page
        const getRoundDistanceContainer = (roundID) => {
            const index = parseInt(roundID.split("-")[1]);
            const rounds = getRoundDistanceContainers();

            if (rounds.length < index) return null;

            return rounds[index - 1];
        };

        // Get a list of the player's result details containers
        const getRoundDistanceContainers = () => {
            return document.querySelectorAll(".results-highscore__guess-cell--round.results-highscore__cell--selected .results-highscore__guess-cell-details");
        };

        // Find the appropriate place to insert the distance traveled for the current page
        const getDistanceContainer = () => {
            const candidates = [
                "[data-qa=guess-description]", // Round summary text
                "[data-qa=final-result-score]", // Game summary text
                "[data-qa=score-description]", // Streak summary text, post-redesign
                ".score-bar__label", // Finds the single-round and game summary text
                ".results-highscore__guess-cell--total.results-highscore__cell--selected .results-highscore__guess-cell-details",
                // Finds the 'Total' cell on the challenge highscore page
                ".streak-result__sub-title", // Finds the streak summary text
            ];

            let result = null;
            for (var i = 0; i < candidates.length; i++) {
                result = document.querySelector(candidates[i]);
                if (result != null) break;
            }
            return result;
        };

        // Inject or update a span with the distance travelled
        const displayDistance = (container, distance, separator = " ") => {
            if (container == null) {
                return;
            }

            let target = container.querySelector(".ggpl_distance");
            if (target == null) {
                target = document.createElement("span");
                target.classList.add("ggpl_distance");
                container.appendChild(target);
            }
            var scale = "m";
            if (distance > 1000) {
                scale = "km";
                distance = distance / 1000;
            }
            target.innerText = separator + "You traveled " + distance.toFixed(1) + " " + scale;
        };

        function calculateAndShowDistances(roundsToShow, distance) {
            var totalDistance = 0;

            roundsToShow.forEach((key) => {
                let distance = getRoundDistance(key);

                // 0 or NaN
                if (!(distance > 0)) return;

                totalDistance += distance;

                var target = getRoundDistanceContainer(key);
                if (target != null) displayDistance(target, distance, " - ");
            });

            if (totalDistance > 0) displayDistance(getDistanceContainer(), totalDistance);
        }

        // Remove all distances older than a week
        function clearOldDistances() {
            let pathData = getData();
            let keys = Object.keys(pathData);

            // Delete all distances older than a week
            const cutoff = Date.now() - KEEP_FOR;
            for (const [gameID, data] of Object.entries(pathData)) {
                if (data.t < cutoff) {
                    delete localStorage.distances[gameID];
                }
            }

            saveData(pathData);
        }

        setTimeout(clearOldDistances, 1000);

        //////////////// Utility functions //////////////////////////////////////////////

        function getData() {
            let pathData = localStorage["pathData"];
            return pathData ? JSON.parse(pathData) : {};
        }

        function saveData(data) {
            localStorage["pathData"] = JSON.stringify(data);
        }

        function isGamePage() {
            let s = location.pathname.startsWith.bind(location.pathname);
            return s("/challenge/") || s("/results/") || s("/game/");
        }

        // Detect if a results screen is visible, so the traces should be shown
        function resultShown() {
            let q = document.querySelector.bind(document);
            return !!q("[data-qa=result-view-bottom]") || location.href.includes("results");
        }

        function isChallenge() {
            return /Challenge/.test(document.title);
        }

        // Detect if only a single result is shown
        function singleResult() {
            let q = document.querySelector.bind(document);
            return !!q("[data-qa=guess-description]") || !!q(".country-streak-result__sub-title");
        }

        // Get the game ID, for storing the trace against
        function id() {
            return location.href.match(/\w{15,}/);
        }

        function roundNumber() {
            const el = document.querySelector("[data-qa=round-number] :nth-child(2)");
            return el ? parseInt(el.innerHTML) : 0;
        }

        function roundID(n, gameID) {
            return (gameID || id()) + "-" + (n || roundNumber());
        }

        // Get the location of the street view
        function getPosition(sv) {
            return {
                lat: +sv.position.lat().toFixed(5),
                lng: +sv.position.lng().toFixed(5),
            };
        }

        function createMenu() {
            if (document.getElementById("pathLoggerMenu")) return false;

            let bodyXY = localStorage["pathLoggerMenuCoords"] ? JSON.parse(localStorage["pathLoggerMenuCoords"]) : { x: 1, y: 1 };

            const container = document.createElement("div");
            const closeX = document.createElement("div");
            const header = document.createElement("div");
            const body = document.createElement("div");

            container.appendChild(header);
            container.appendChild(body);
            container.appendChild(closeX);

            container.style.cssText = `display:flex; flex-direction:column; position: absolute; z-index: 9999;padding: 5px; top: ${~~bodyXY.y}%; left: ${~~bodyXY.x}%; background-color: white; border-radius: 1ch; max-height: 50%; font-family: var(--font-neo-sans);`;
            container.id = "pathLoggerMenu";
            container.addEventListener("mousedown", function (e) {
                if (e.target != header) return;

                document.body.addEventListener("mousemove", mmove);
                document.body.addEventListener("mouseup", mup);
                let _y = document.body.clientHeight * (bodyXY.y / 100);
                let _x = document.body.clientWidth * (bodyXY.x / 100);

                let yy = _y - e.y;
                let xx = e.x - _x;

                function mmove(evt) {
                    if (Math.abs(evt.x - e.x) > 2 || Math.abs(evt.y - e.y) > 2) {
                        document.body.removeEventListener("mousemove", mmove);
                        document.body.addEventListener("mousemove", _mmove);
                    }
                }

                function _mmove(evt) {
                    container.style.top = evt.y + yy + "px";
                    container.style.left = evt.x - xx + "px";
                }

                function mup(evt) {
                    document.body.removeEventListener("mousemove", mmove);
                    document.body.removeEventListener("mousemove", _mmove);
                    document.body.removeEventListener("mouseup", mup);

                    bodyXY.y = ((evt.y + yy) / document.body.clientHeight) * 100;
                    bodyXY.x = ((evt.x - xx) / document.body.clientWidth) * 100;

                    container.style.top = bodyXY.y + "%";
                    container.style.left = bodyXY.x + "%";

                    localStorage["pathLoggerMenuCoords"] = JSON.stringify(bodyXY);
                }
            });

            header.style.cssText = `border-bottom: 1px solid grey; padding: 5px; padding-right: calc(1ch + 9px); cursor: all-scroll;`;

            body.style.cssText = "height: calc(100% - 2rem); overflow-y: scroll;";

            closeX.style.cssText = `position: absolute; top: 5px; right: 5px; padding: 2px; font-size: 1ch; width: 15px; height: 15px; cursor: pointer; background: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Cpath%20d%3D%22M19%206.41L17.59%205%2012%2010.59%206.41%205%205%206.41%2010.59%2012%205%2017.59%206.41%2019%2012%2013.41%2017.59%2019%2019%2017.59%2013.41%2012z%22/%3E%3Cpath%20d%3D%22M0%200h24v24H0z%22%20fill%3D%22none%22/%3E%3C/svg%3E");`;
            closeX.addEventListener("click", function () {
                container.parentElement.removeChild(container);
            });

            document.body.appendChild(container);

            return { body: body, header: header, container: container };
        }
    })
);
