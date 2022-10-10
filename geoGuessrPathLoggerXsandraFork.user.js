// ==UserScript==
// @name Fork of xsandra's GeoGuessr Path Logger by echandler v15
// @namespace GeoGuessr
// @description Add a trace of where you have been to GeoGuessr’s results screen
// @version 15
// @include https://www.geoguessr.com/*
// @downloadURL https://github.com/echandler/Fork-of-xsandra-s-GeoGuessr-Path-Logger-script/raw/main/geoGuessrPathLoggerXsandraFork.user.js
// @copyright 2021, xsanda (https://openuserjs.org/users/xsanda)
// @license MIT
// @run-at document-start
// @grant GM_registerMenuCommand
// @grant  GM_unregisterMenuCommand
// ==/UserScript==

const MAPS_API_URL = "https://maps.googleapis.com/maps/api/js?";

let GM_menu = {
    id: null,
    create: function () {
        let state = JSON.parse(localStorage["pathLoggerAnimation"] || 1);

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

window.googleMapsPromise = new Promise((resolve, reject) => {
    try {
        // Watch <head> and <body> for the Google Maps script to be added
        let scriptObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.tagName === "SCRIPT" && node.src.startsWith(MAPS_API_URL)) {
                        // When it’s been added and loaded, load the script below.
                        node.addEventListener("load", () => resolve()); // jshint ignore:line
                        if (scriptObserver) scriptObserver.disconnect();
                        scriptObserver = undefined;
                    }
                }
            }
        });

        // Wait for the head and body to be actually added to the page, applying the
        // observer above to these elements directly.
        // There are two separate observers because only the direct children of <head>
        // and <body> should be watched, but these elements are not necessarily
        // present at document-start.
        let bodyDone = false;
        let headDone = false;

        new MutationObserver((_, observer) => {
            if (!bodyDone && document.body) {
                bodyDone = true;
                if (scriptObserver)
                    scriptObserver.observe(document.body, {
                        childList: true,
                    });
            }
            if (!headDone && document.head) {
                headDone = true;
                if (scriptObserver)
                    scriptObserver.observe(document.head, {
                        childList: true,
                    });
            }
            if (headDone && bodyDone) observer.disconnect();
        }).observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    } catch (e) {
        alert("Something happened with the GeoGuessr Path Logger script. Reloading the page will probably fix it.");
        // Promise will not short ciruit if reject is called.
        //reject(e);
    }
}); //.catch(function(reason){
// console.log(reason);
//  });

function runAsClient(f) {
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.text = "(async () => { try { await (" + f.toString() + ")(); } catch (e) { console.error(e); }})();";
    document.body.appendChild(s);
}

window.runAsClient = runAsClient;

googleMapsPromise.then(() =>
    runAsClient(() => {
        debugger;

        let g_SVObject = null;

        const google = window.google;

        const KEEP_FOR = 1000 * 60 * 60 * 24 * 7; // 1 week

        // Keep a track of the lines drawn on the map, so they can be removed
        let pathStuff = [];

        function isGamePage() {
            let s = location.pathname.startsWith.bind(location.pathname);
            return s("/challenge/") || s("/results/") || s("/game/");
        }

        // Detect if a results screen is visible, so the traces should be shown
        function resultShown() {
            let q = document.querySelector.bind(document);
            return !!q("[data-qa=result-view-bottom]") || location.href.includes("results");
        }

        // Detect if only a single result is shown
        function singleResult() {
            let q = document.querySelector.bind(document);
            return !!q("[data-qa=guess-description]") || !!q(".country-streak-result__sub-title");
        }

        // Keep a track of whether we are in a round already
        let inGame = false;

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
                lat: sv.position.lat(),
                lng: sv.position.lng(),
            };
        }

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

        clearOldGames();

        // Keep a track of the current round’s route
        let route = undefined;

        let currentRound = undefined;

        // Keep a track of the start location for the current round, for detecting the return to start button
        let start = undefined;

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
                } else if (currentRound !== roundID()) {
                    currentRound = roundID();
                    start = position;
                    route = { pathCoords: [], checkPointCoords: [] };
                }

                // If we’re at the start, begin a new trace
                if (position.lat == start.lat && position.lng == start.lng) {
                    route.pathCoords.push([]);
                }

                const cur = route.pathCoords[route.pathCoords.length - 1];

                // Add the location to the trace
                cur.push(position);
            } catch (e) {
                console.error("GeoGuessr Path Logger Error:", e);
            }
        }

        let mapState = 0;

        // The geometry API isn’t loaded unless a Street View has been displayed since the last load.
        const loadGeometry = () =>
            new Promise((resolve, reject) => {
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

        function onMapIdleEvent(map_) {
            try {
                if (!isGamePage()) return;

                if (!google.maps.geometry) {
                    loadGeometry().then(() => onMapIdleEvent(map_));
                    return;
                }

                // create a checksum of the game state, only updating the map when this changes, to save on computation
                const newMapState = (resultShown() ? 10 : 0) + (singleResult() ? 20 : 0) + roundNumber();
                if (newMapState == mapState) return;
                mapState = newMapState;

                // Hide all traces
                pathStuff.forEach((m) => m.forEach((n_) => n_.setMap(null)));

                // If we’re looking at the results, draw the traces again
                if (resultShown()) {
                    // If we were in a round the last time we checked, then we need to save the route
                    if (inGame) {
                        // encode the route to reduce the storage required.
                        let pathData = getData();

                        const encodedRoutes = {
                            p: route.pathCoords.map((path) => google.maps.geometry.encoding.encodePath(path.map((point) => new google.maps.LatLng(point)))),
                            c: route.checkPointCoords,
                            t: Date.now(),
                        };

                        pathData[roundID()] = encodedRoutes;

                        saveData(pathData);
                    }

                    inGame = false;
                    // Show all rounds for the current game when viewing the full results
                    const pathData = getData();
                    const roundsToShow = singleResult() ? [roundID()] : Object.keys(pathData).filter((map) => map.startsWith(id()));

                    pathStuff = roundsToShow
                        .map((key) => pathData[key]) // Get the map for this round
                        .filter((r) => r) // Ignore missing rounds
                        .map((r) => {
                            const ret = [];

                            const pathCoords = [];

                            ret.push(
                                r.p.map((_polyline) => {
                                    let coords = google.maps.geometry.encoding.decodePath(_polyline);

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
                            );

                            ret.push(
                                r.c.map(
                                    (point) =>
                                        new google.maps.Circle({
                                            center: point,
                                            radius: 4,
                                            strokeColor: "rebeccapurple", //"#B40404",
                                            strokeOpacity: 0.6,
                                            strokeWeight: 0,
                                            fillColor: "rebeccapurple", //"#B40404",
                                            fillOpacity: 0.6,
                                        })
                                )
                            );
                            return ret.flatMap((x) => x);
                        });

                    // Add all traces to the map

                    pathStuff.forEach((m_) => {
                        let thisLineAnimation = null;

                        m_.forEach((n_) => {
                            let _infoWindow = null;

                            n_.setMap(map_);

                            n_.addListener("click", makeLineAnimation);

                            n_.addListener("mouseover", function (e) {
                                if (_infoWindow !== null) return;
                                const state = JSON.parse(localStorage["pathLoggerAnimation"] || 1);

                                const d = document.createElement("div");
                                d.style.cssText = "color:black; font-size: 1.2em;";
                                d.innerHTML = '<span>Click line to start animation. Press "[" or "]" to change speed.<span>';

                                const btn = document.createElement("button");
                                btn.style.cssText = "display: block; margin-top: 1em;";
                                btn.onclick = function (e) {
                                    localStorage["pathLoggerAnimation"] = !JSON.parse(localStorage["pathLoggerAnimation"] || 1);
                                    btn.innerText = JSON.parse(localStorage["pathLoggerAnimation"] || 1) == 1 ? "Turn auto play off" : "Turn auto play on";
                                };

                                btn.innerText = state == 1 ? "Turn auto play off" : "Turn auto play on";
                                d.appendChild(btn);

                                _infoWindow = setTimeout(function () {
                                    _infoWindow = new google.maps.InfoWindow({
                                        content: d,
                                        position: e.latLng,
                                    });

                                    _infoWindow.open(map_);

                                    setTimeout(() => {
                                        _infoWindow.close();
                                        _infoWindow = null;
                                    }, 5000);
                                }, 2000);
                            });

                            n_.addListener("mouseout", function (e) {
                                clearTimeout(_infoWindow);
                                if (typeof _infoWindow === "number") _infoWindow = null;
                            });

                            const oldPolyLineSetMap = n_.setMap;
                            n_.setMap = function () {
                                if (thisLineAnimation) {
                                    thisLineAnimation.clear();
                                    thisLineAnimation = null;
                                }
                                oldPolyLineSetMap.apply(n_, arguments);
                            };

                            if (!thisLineAnimation && JSON.parse(localStorage["pathLoggerAnimation"] || 1)) {
                                makeLineAnimation();
                            }

                            function makeLineAnimation() {
                                let t = 1;
                                if (thisLineAnimation) {
                                    thisLineAnimation.clear();
                                    thisLineAnimation = null;
                                    document.body.removeEventListener("keypress", _keypress);
                                    return;
                                }

                                thisLineAnimation = addAnimatedMarker(n_._coords, t, map_);

                                markerListener();

                                document.body.addEventListener("keypress", _keypress);

                                function _keypress(e) {
                                    if (e.key === "]") {
                                        t *= 2;
                                        thisLineAnimation.clear();
                                        thisLineAnimation = addAnimatedMarker(n_._coords, t, map_);
                                        markerListener();
                                    } else if (e.key === "[") {
                                        t /= 2;
                                        thisLineAnimation.clear();
                                        thisLineAnimation = addAnimatedMarker(n_._coords, t, map_);
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
                }
            } catch (e) {
                console.error("GeoGuessr Path Logger Error:", e);
            }
        }

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

        function getData() {
            let pathData = localStorage["pathData"];
            return pathData ? JSON.parse(pathData) : {};
        }

        function saveData(data) {
            localStorage["pathData"] = JSON.stringify(data);
        }

        setInterval(function () {
            // Run forever.
            makeGeoGuessrButtonListeners();
        }, 1000);

        function makeGeoGuessrButtonListeners() {
            const setUndo = document.querySelector('button[data-qa="undo-move"]');
            const setCheckPoint = document.querySelector('button[data-qa="set-checkpoint"]');

            if (!setCheckPoint || setCheckPoint._state !== undefined) return;

            setCheckPoint._state = 0;

            setCheckPoint.addEventListener("click", function (e) {
                setCheckPoint._state = setCheckPoint._state === 1 ? 0 : 1;
                if (setCheckPoint._state === 1) {
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

            setUndo.addEventListener("click", function (e) {
                route.pathCoords.push([]);
            });
        }

        function addAnimatedMarker(pathCoords_, multiplier_, map_) {
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
                map: map_,
                icon: lineSymbol,
            });

            const d = [];
            let totalDistance = 0;

            pathCoords_ = pathCoords_.flatMap((x) => x);

            let p = 0;

            for (let n = 0; n < pathCoords_.length; n++) {
                if (n + 1 >= pathCoords_.length) continue;

                const start = pathCoords_[n];
                const finish = pathCoords_[n + 1];
                const lineLength = Math.sqrt(Math.abs(start.lat() - finish.lat()) ** 2 + Math.abs(start.lng() - finish.lng()) ** 2);

                totalDistance += lineLength;

                if (lineLength > 0.001) {
                    // This line is assumed to be a jump to teleport to start or something like that.
                    totalDistance -= lineLength;
                    p += 3;
                }

                d.push(lineLength);
            }

            const oneMeter = 0.00001; /*1.111 meters*/

            let spd = totalDistance / (oneMeter * 150);
            spd = spd < 6 ? 6 + p : spd; // Short routes should run slower.

            const speed = (totalDistance / oneMeter / spd) * multiplier_;

            const frames = [];

            let fromLat = pathCoords_[0].lat();
            let fromLng = pathCoords_[0].lng();

            for (let n = 0; n < d.length; n++) {
                // One frame = one set of lat lng coords.

                if (n + 1 >= pathCoords_.length) continue;

                const toLat = pathCoords_[n + 1].lat();
                const toLng = pathCoords_[n + 1].lng();

                let incs = Math.ceil((d[n] / oneMeter / speed) * 60);

                if (d[n] > 0.001) {
                    // Speed up for long distances. Could be teleporting to start.
                    incs = Math.ceil((d[n] / oneMeter / (speed * 6)) * 60);
                }

                for (let m = 0; m < incs; m++) {
                    const curLat = fromLat + (m / incs) * (toLat - fromLat);
                    const curLng = fromLng + (m / incs) * (toLng - fromLng);
                    frames.push(new google.maps.LatLng(curLat, curLng));
                }

                fromLat = toLat;
                fromLng = toLng;
            }

            frames.push(pathCoords_[pathCoords_.length - 1]); // Make sure last coord is on.

            let index = 0;

            function animationCallback() {
                if (index >= frames.length) {
                    index = 0;

                    setTimeout(() => {
                        // Pause at end then go to start.
                        marker.setPosition(frames[index++]);
                        setTimeout(() => requestAnimationFrame(animationCallback), 600);
                    }, 1000);

                    return;
                }

                marker.setPosition(frames[index++]);

                requestAnimationFrame(animationCallback);
            }

            requestAnimationFrame(animationCallback);

            return {
                clear: () => {
                    marker.setMap(null);
                    animationCallback = null;
                },
                marker: marker,
            };
        }
    })
);
