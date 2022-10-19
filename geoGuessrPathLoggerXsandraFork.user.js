// ==UserScript==
// @name Fork of xsandra's GeoGuessr Path Logger by echandler v21
// @namespace GeoGuessr
// @description Add a trace of where you have been to GeoGuessr’s results screen
// @version 21
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
        debugger;

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

                // If we’re looking at the results, draw the traces again
                if (resultShown()) {
                    // If we were in a round the last time we checked, then we need to save the route
                    if (inGame) {
                        // encode the route to reduce the storage required.
                        let pathData = getData();

                        const encodedRoutes = {
                            p: route.pathCoords,
                            c: route.checkPointCoords,
                            t: Date.now(),
                        };

                        pathData[roundID()] = encodedRoutes;

                        saveData(pathData);

                        setRoundDistance(distance);
                    }

                    inGame = false;
                    // Show all rounds for the current game when viewing the full results
                    const pathData = getData();
                    const roundsToShow = singleResult() ? [roundID()] : Object.keys(pathData).filter((map) => map.startsWith(id()));

                    pathStuff = roundsToShow
                        .map((key) => pathData[key]) // Get the map for this round
                        .filter((r) => r) // Ignore missing rounds
                        .map((r) => {
                            let ret = [];

                            const pathCoords = [];

                            ret.push(
                                r.p.map((_polyline) => {
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
                            );

                            ret.push(
                                r.c.map((point) => {
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
                            );

                            if (ret[0].length === 1 && ret[0][0]._coords[0].length <= 3) {
                                // Player probably didn't move, maybe photoshere.
                                return [];
                            }

                            ret = ret.flatMap((x) => x); // For breakpoint in devtools.

                            return ret;
                        });

                    // Add all traces to the map

                    pathStuff.forEach((m_) => {
                        let thisLineAnimation = null;

                        m_.forEach((n_) => {
                            let _infoWindow = null;

                            n_.setMap(map_);

                            n_.addListener("click", makeLineAnimation.bind(null, true));

                            n_.addListener("mouseover", function (e) {
                                if (_infoWindow !== null) return;
                                const state = JSON.parse(localStorage["pathLoggerAnimation"] ?? 1);

                                const d = document.createElement("div");
                                d.style.cssText = "color:black; font-size: 1.2em;";
                                d.innerHTML = '<span>Click line to start animation. Press "[" or "]" to change speed.<span>';

                                const btn = document.createElement("button");
                                btn.style.cssText = "display: block; margin-top: 1em;";
                                btn.onclick = function (e) {
                                    localStorage["pathLoggerAnimation"] = !JSON.parse(localStorage["pathLoggerAnimation"] ?? 1);
                                    btn.innerText = JSON.parse(localStorage["pathLoggerAnimation"] ?? 1) == 1 ? "Turn auto play off" : "Turn auto play on";
                                    GM_menu.create();
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

                                thisLineAnimation = "waiting";

                                setTimeout(
                                    function (n_, animationMultiplier, map_) {
                                        // Wait for the map to finish between rounds before animating.
                                        thisLineAnimation = createAnimatedMarker(n_._coords, animationMultiplier, map_);
                                        markerListener();
                                    },
                                    startAnimationNow ? 1 : 2000,
                                    n_,
                                    animationMultiplier,
                                    map_
                                );

                                document.body.addEventListener("keypress", _keypress);

                                function _keypress(e) {
                                    if (e.key === "]") {
                                        animationMultiplier *= 2;
                                        thisLineAnimation.clear();
                                        thisLineAnimation = createAnimatedMarker(n_._coords, animationMultiplier, map_);
                                        markerListener();
                                    } else if (e.key === "[") {
                                        animationMultiplier /= 2;
                                        thisLineAnimation.clear();
                                        thisLineAnimation = createAnimatedMarker(n_._coords, animationMultiplier, map_);
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

                    calculateAndShowDistances(roundsToShow, distance);
                }
            } catch (e) {
                console.error("GeoGuessr Path Logger Error:", e);
            }
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

                let incs = (to.time - from.time - 1000 /*milliseconds*/) / multiplier_ / (1000 / 60) /*16 frames per second*/;
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
                lat: sv.position.lat(),
                lng: sv.position.lng(),
            };
        }
    })
);
