import './style.css'
import * as THREE from 'three'
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js'
import * as dat from 'dat.gui'
//Farouq tells you : this is where all the magic happen......
var options = {
	NAME:"GENERAL",
	version:0, 
    framerate: 60,
    G: 20,
	
    START_SPEED: 20,
    MOVER_COUNT: 32,
	
    TRAILS_DISPLAY: true,
    SHOW_DIED: false,
    SHOW_LABELS: true, 
    TRAILS_LENGTH: 1000,
	
    MIN_MASS: .01,
    MAX_MASS: 1000,
    
	DENSITY: 0.1,

    MoveSpeed: 500,
    MAX_DISTANCE: 300000,
    BIG_STAR_MASS:100000,
	
	MASS_FACTOR : .01 // for display of size
};

// LOAD / SAVE CONFIG

var optionsSvgName = "options";
// Force Reset Config ? 
var httpReset = GET('R');
if(httpReset){
	console.log("Force Reset Initial Config:" + httpReset);
}
// LOAD CONFIG 
else if (localStorage && localStorage.getItem(optionsSvgName)){
    optionsSVG = JSON.parse(localStorage.getItem(optionsSvgName));
	if(optionsSVG.NAME==options.NAME){
		console.log("LOAD CONFIG:" + optionsSvgName);
		for (var key in optionsSVG) {
			console.log(key, optionsSVG[key]);
			options.key = optionsSVG.key;
			options[key] = optionsSVG[key];
		}
	} else {
		console.log("BAD LOAD CONFIG:" + optionsSVG.NAME + " - EXPECTED:" + options.NAME + " > NO LOAD");
		console.log(options);
	}
} else {
	console.log("No Saved Config:" + optionsSvgName);
}
options.SAVECONFIG = function () {
    // SVG CONFIG OPTIONS
    localStorage.setItem(optionsSvgName, JSON.stringify(options));
	console.log("Saved Config:" + optionsSvgName);
}



options.AddBigStar = function () {
	AddBigMoverToCenter();
}

options.RESET = function () {
    reset();
}


// dat GUI
var gui = new dat.GUI();
var f = gui.addFolder('Environment');
f.open();
//f.add(options, 'framerate', 1, 120);
f.add(options, 'G', 1, 1000).name("Gravity");

var fMoverCountE = f.add(options, 'MOVER_COUNT', 1, 128);
fMoverCountE.onFinishChange(function (value) {
    // Fires when a controller loses focus.
    //reset();
});

f = gui.addFolder('Trails & Labels');
f.open();
f.add(options, 'TRAILS_DISPLAY');
f.add(options, 'TRAILS_LENGTH', 0, 10000);

f.add(options, 'SHOW_DIED');
f.add(options, 'SHOW_LABELS');

f = gui.addFolder('Masses');
f.open();

var fMinMassChangeE = f.add(options, 'MIN_MASS', .00001, 10000.0);
fMinMassChangeE.onFinishChange(function (value) {
    if(options.MAX_MASS<options.MIN_MASS){
        options.MAX_MASS = value;
        fMaxMassChangeE.updateDisplay();
    }
    //reset();
});

var fMaxMassChangeE = f.add(options, 'MAX_MASS', .00001, 10000.0);
fMaxMassChangeE.onFinishChange(function (value) {
    if(options.MAX_MASS<options.MIN_MASS){
        options.MIN_MASS = value;
        fMinMassChangeE.updateDisplay();
    }
    //reset();
});

f = gui.addFolder('Start');
f.open();

var fDensityE = f.add(options, 'DENSITY', 1e-100, 1.0);
fDensityE.onFinishChange(function (value) {
    //reset();
});

var fSpeedE = f.add(options, 'START_SPEED', 1e-100, 100.0);
fSpeedE.onFinishChange(function (value) {
    //reset();
});

var moveSpeed = 100;
f.add(options, 'MoveSpeed', 1, 1000).onFinishChange(function (value) {
    //console.log(value);
    moveSpeed = Math.floor(options.MoveSpeed);
    console.log(moveSpeed);
});

f.add(options, 'AddBigStar').name('Add Big Star');
f.add(options, 'SAVECONFIG').name('SaveTheConf');
f.add(options, 'RESET').name('RESET ALL');

//var FPS = 60;
var MASS_FACTOR = options.MASS_FACTOR;

var SPHERE_SIDES = 12;
//var TRAILS_LENGTH = 100;

var zoom = 1.0;
var translate = new THREE.Vector3();

var movers = [];
//var container =  false; // ME
//var textlabels = [];

var now;
var then = Date.now();
var renderInterval = 1000 / parseInt(options.framerate);
var renderDelta;

var scene = new THREE.Scene({
    castShadow: true
});

// CAMERA 

var cameraOrtho = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100000000.0);
//var cameraFPS   = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100000000.0);

var camera = cameraOrtho
var renderer = new THREE.WebGLRenderer({
    preserveDrawingBuffer: true
});
//var projector = new THREE.Projector();

var initCam = {};
initCam.theta = 20;
initCam.phi = 10;
initCam.radius = 5*2000.0;

setCamera(initCam);

isShowCamPerspectiveHelper = false;
if(isShowCamPerspectiveHelper){
    cameraPerspectiveHelper = new THREE.CameraHelper(camera);
    scene.add(cameraPerspectiveHelper);
}


var controlOrbit = new THREE.OrbitControls(camera, renderer.domElement);
controlOrbit.zoomSpeed = 100

var controls = controlOrbit;

var direction;


var lineMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff
});

scene.castShadow = true;
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.autoClearColor = true;
//renderer.shadowMapEnabled=true;
document.body.appendChild(renderer.domElement);
//var geometry = new THREE.SphereGeometry(1.0,8,8);
//cube = new THREE.Mesh(geometry, material);
//scene.add(cube);
var cube;

// SELECTED VAR
var biggest
var selection
var lastOne


// MATERIAL 

var basicMaterial = new THREE.MeshLambertMaterial({
    ambient: 0x111111,
    diffuse: 0x555555,
    specular: 0xffffff,
    shininess: 50
});

var selectedMaterial = new THREE.MeshLambertMaterial({
    ambient: 0xaaaaaa,
    diffuse: 0xdddddd,
    specular: 0xffffff,
    shininess: 50,
    emissive: 0x000000
});

// LIGHT

// add subtle ambient lighting
// directional lighting
var directionalLight = new THREE.DirectionalLight(0x666666);
directionalLight.position.set(1000, 1000, 1000);
directionalLight.castShadow = true;
//scene.add(directionalLight);

var selectionLight = new THREE.PointLight(0xff0000, 0);
selectionLight.castShadow = true;
scene.add(selectionLight); // ?? 

 // FRAMERATE

var $real_framerate = $("#real_framerate");
var $framerate = $("#framerate");
$framerate.bind("change keyup mouseup", function () {
    var v = parseInt(this.value);
    if (v > 0) {
        //options.framerate = v;
        renderInterval = 1000 / parseInt(options.framerate);
    }
}).change();

// JSQUERY GUI

var $movers_alive_count = $("#movers_alive_count");
var $total_mass = $("#total_mass");
var $maximum_mass = $("#maximum_mass");
var $largest_pos = $("#largest_pos");
var $select_infos = $("#select_infos");
var $camera_info = $("#camera_info");
var GeneralInfos = document.getElementById('GeneralInfos');
var IHMButtons = document.getElementById('IHMButtons');
var tracker;

// IHM BUTTON ALL 
// --------------
var htmlButtonALL = document.createElement("BUTTON")
//htmlButtonALL.style.backgroundColor = '#' + this.color.getHexString();

htmlButtonALL.label = t = document.createTextNode('ALL');
htmlButtonALL.label.data = 'ALL'; 
htmlButtonALL.appendChild(t);
IHMButtons.appendChild(htmlButtonALL);

htmlButtonALL.addEventListener ("click", function() {
    //alert("did something");
    ClearSelection();
    isMoverSelected = false; 
  });


var displayMass = false;
//var displayTrails = $activate_trails.is(":checked");;
reset();

var pause = false;

// AXIS HELPERS

var axesHelper = new THREE.AxesHelper(5000*10);
scene.add(axesHelper);

// DRAW RENDER 

function draw() {
    requestAnimationFrame(draw);
    now = Date.now();
    renderDelta = now - then;
    if (renderDelta > renderInterval) {
        then = now - (renderDelta % renderInterval);
        render();
    }
}
draw();

var lastTimeCalled = new Date();
var countFramesPerSecond = 0;
var total_mass = 0;

// RENDER

//var moveSpeed = 100;
function render() {
    if(isShowCamPerspectiveHelper){
        cameraPerspectiveHelper.update();
        cameraPerspectiveHelper.visible = true;
    }

    // DEPLACEMENT 
    var vector = new THREE.Vector3();
    var direction = camera.getWorldDirection(vector);
    if (holdUp) {
        camera.position.add(vector.multiplyScalar(moveSpeed));
    } else if (holdDown) {
        camera.position.sub(direction.multiplyScalar(moveSpeed));
    }

    // TIMER
    var timeNow = new Date();
    if (lastTimeCalled && timeNow.getMilliseconds() < lastTimeCalled.getMilliseconds()) {
        $real_framerate.html(countFramesPerSecond);
        countFramesPerSecond = 1;
    } else {
        countFramesPerSecond += 1;
    }

    var movers_alive_count = 0;
    total_mass = 0;
    var maximum_mass = 0.00;

    if (biggest)
        largest_pos = 'dist: ' + NumToFormat(biggest.location.distanceTo(camera.position)) + ' id:' + biggest.id;
    else
        largest_pos = 0


    if (movers && movers.length) {
        if (!pause) {

            // FIRST LOOP
            for (var i = movers.length - 1; i >= 0; i--) {
                var m = movers[i];

                if (m.alive) {
                    movers_alive_count++;
                    total_mass += m.mass;
                    if (m.mass > maximum_mass) {
                        maximum_mass = m.mass;

                        biggest = m;
                    }

                    // SECOND LOOP 
                    for (var j = movers.length - 1; j >= 0; j--) {
                        var a = movers[j];
                        if (movers[i].alive && movers[j].alive && i != j) {
                            var distance = m.location.distanceTo(a.location);
							
                            var radiusM = Math.pow((m.mass / MASS_FACTOR / MASS_FACTOR / 4 * Math.PI), 1 / 3) / 3;
                            var radiusA = Math.pow((a.mass / MASS_FACTOR / MASS_FACTOR / 4 * Math.PI), 1 / 3) / 3;

                            if (distance < radiusM + radiusA) {
                                // merge objects
                                if (a.mass > m.mass)
                                    a.eat(m);
                                else
                                    m.eat(a);
                            } else {
                                a.attract(m);
                            }
                        }
                    }
                }
            }
        }
        // DISPLAY
        for (var i = movers.length - 1; i >= 0; i--) {
            var m = movers[i];
            if (m.alive && m.distanceToCenter() < options.MAX_DISTANCE) {
                if (!pause) {
                    m.update();
                }
            }
            m.display(displayMass); // ME déplacé ici 
            updateTrails(m);
        }

		// AUTOZOOM ON SELECTION 
		if(!pause && document.getElementById('cbZoom').checked){
			if(selection.mesh){
				if(selection.mesh.position.distanceTo(camera.position)>7000){
					direction2 = direction.clone().multiplyScalar(moveSpeed);
					//console.log(direction2.length());
					camera.position.x += direction2.x;
					camera.position.y += direction2.y;
					camera.position.z += direction2.z;
				} else {
					// STOP The AutoZoomIn
					document.getElementById("cbZoom").checked = false;
				}
			} else {
				console.log("selection.mesh undefined :" + selection.id)
			}
		}
			
        // Fix Follow FPC CAM if Enabled 
        if (selection && document.getElementById('cbFPS').checked) {
            camera.lookAt(selection.mesh.position);
			controls.enabled = false; // TODO WHY HERE ??

		} else if (selection && document.getElementById('cbFollowOrbitCam').checked) {
			camera.lookAt(selection.mesh.position);
			// controls.enabled = true; // TODO ?? 
		} else {
			
		}

        // INFOS PANEL
        $movers_alive_count.html(movers_alive_count + ' / ' + movers.length);
        var rapportMasse = maximum_mass / total_mass * 100;

        $maximum_mass.html(NumToFormat(maximum_mass));
        $maximum_mass.css('color', "#" + biggest.mesh.material.color.getHexString());
        $total_mass.html(NumToFormat(total_mass) + ' = ' + NumToFormat(rapportMasse) + '%' );

        $largest_pos.html(largest_pos);
        $largest_pos.css('color', "#" + biggest.mesh.material.color.getHexString());

        // camera 
        if(document.getElementById('cbCam').checked)
            $camera_info.html( LogCam() + LogFPCam() ) ;
        else $camera_info.html('');

        // selection info/debug
        if (selection) {
            $select_infos.html(LogSelection());
            $select_infos.css('color', "#" + selection.mesh.material.color.getHexString());
        }

        if(pause)
            document.getElementById('GeneralInfos').innerHTML='PAUSE : Press SPACE to Run';
        else 
            document.getElementById('GeneralInfos').innerHTML='RUNNING : Press SPACE to Stop'; 
    
    }
    // RENDERER
    controls.update(clock.getDelta());
    renderer.render(scene, camera);

    lastTimeCalled = new Date();
}

function reset() {
    console.log("RESET ALL !")
    if (movers) {
        for (var i = 0; i < movers.length; i = i + 1) {
			RemoveMover(movers[i], i);
        }
    }
    movers = [];

    // generate N movers with random mass (N = MOVER_COUNT)
    for (var i = 0; i < parseInt(options.MOVER_COUNT); i = i + 1) {
        AddRandomMover(i);
    }
    selection = AddBigMoverToCenter();
}


