import {
    Color,
    WebGLRenderer,
    Scene,
    PerspectiveCamera,
    Mesh,
    SphereGeometry,
    MeshMatcapMaterial,
    PlaneGeometry,
    ShaderMaterial,
    AxesHelper,
    Vector2,
    ShaderChunk,
    ShaderLib,
    UniformsUtils,
    HalfFloatType,
    ClampToEdgeWrapping,
    NearestFilter,
    RGBAFormat, UnsignedByteType, WebGLRenderTarget,
} from 'three'
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js'
import Stats from 'stats-js'
import LoaderManager from '@/js/managers/LoaderManager'
import GUI from 'lil-gui'
import waterVertexShader from '@/js/glsl/v0/water.vert'
import {GPUComputationRenderer} from "three/addons/misc/GPUComputationRenderer.js";
import smoothFragmentShader from '@/js/glsl/v0/smoothing.frag'
import readWaterLevelFragmentShader from '@/js/glsl/v0/read_water_level.frag'
import heightmapFragmentShader from '@/js/glsl/v0/heightmap.frag'
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';

const simplex = new SimplexNoise();

const WIDTH = 128;

// Water size in system units
const BOUNDS = 512;
let waterUniforms;
let gpuCompute;
let heightmapVariable;
let smoothShader;
let readWaterLevelShader;
let readWaterLevelImage;
let readWaterLevelRenderTarget;


export default class MainScene {
    #canvas
    #renderer
    #scene
    #camera
    #controls
    #stats
    #width
    #height
    #mesh
    #plane_mesh
    #guiObj = {
        y: 0,
        showTitle: true,
    }

    constructor() {
        this.#canvas = document.querySelector('.scene')

        this.init()
    }

    init = async () => {
        // Preload assets before initiating the scene
        const assets = [
            {
                name: 'matcap',
                texture: './img/matcap.png',
            },
        ]

        await LoaderManager.load(assets)

        this.setStats()
        this.setGUI()
        this.setScene()
        this.setRender()
        this.setCamera()
        this.setControls()
        this.setAxesHelper()

        this.setSphere()
        this.setWater()

        this.handleResize()

        // start RAF
        this.events()
    }

    /**
     * Our Webgl renderer, an object that will draw everything in our canvas
     * https://threejs.org/docs/?q=rend#api/en/renderers/WebGLRenderer
     */
    setRender() {
        this.#renderer = new WebGLRenderer({
            canvas: this.#canvas,
            antialias: true,
        })
    }

    /**
     * This is our scene, we'll add any object
     * https://threejs.org/docs/?q=scene#api/en/scenes/Scene
     */
    setScene() {
        this.#scene = new Scene()
        this.#scene.background = new Color(0xffffff)
    }

    /**
     * Our Perspective camera, this is the point of view that we'll have
     * of our scene.
     * A perscpective camera is mimicing the human eyes so something far we'll
     * look smaller than something close
     * https://threejs.org/docs/?q=pers#api/en/cameras/PerspectiveCamera
     */
    setCamera() {
        const aspectRatio = this.#width / this.#height
        const fieldOfView = 60
        const nearPlane = 0.1
        const farPlane = 10000

        this.#camera = new PerspectiveCamera(fieldOfView, aspectRatio, nearPlane, farPlane)
        this.#camera.position.y = 5
        this.#camera.position.x = 5
        this.#camera.position.z = 5
        this.#camera.lookAt(0, 0, 0)

        this.#scene.add(this.#camera)
    }

    /**
     * Threejs controls to have controls on our scene
     * https://threejs.org/docs/?q=orbi#examples/en/controls/OrbitControls
     */
    setControls() {
        this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement)
        this.#controls.enableDamping = true
        // this.#controls.dampingFactor = 0.04
    }

    /**
     * Axes Helper
     * https://threejs.org/docs/?q=Axesh#api/en/helpers/AxesHelper
     */
    setAxesHelper() {
        const axesHelper = new AxesHelper(3)
        this.#scene.add(axesHelper)
    }

    /**
     * Create a SphereGeometry
     * https://threejs.org/docs/?q=box#api/en/geometries/SphereGeometry
     * with a Basic material
     * https://threejs.org/docs/?q=mesh#api/en/materials/MeshBasicMaterial
     */
    setSphere() {
        const geometry = new SphereGeometry(1, 32, 32)
        const material = new MeshMatcapMaterial({matcap: LoaderManager.assets['matcap'].texture})

        this.#mesh = new Mesh(geometry, material)
        this.#scene.add(this.#mesh)
    }

    setWater() {
        const materialColor = 0x0040C0;
        const geometry = new PlaneGeometry(BOUNDS, BOUNDS, WIDTH - 1, WIDTH - 1);
        const material = new ShaderMaterial({
            uniforms: UniformsUtils.merge([
                ShaderLib['phong'].uniforms,
                {
                    'heightmap': {value: null}
                }
            ]),
            vertexShader: waterVertexShader,
            fragmentShader: ShaderChunk['meshphong_frag']
        });

        material.lights = true;

        material.uniforms['diffuse'].value = new Color(materialColor);
        material.uniforms['specular'].value = new Color(0x111111);
        material.uniforms['shininess'].value = Math.max(50, 1e-4);
        material.uniforms['opacity'].value = material.opacity;
        material.defines.WIDTH = WIDTH.toFixed(1);
        material.defines.BOUNDS = BOUNDS.toFixed(1);

        this.#plane_mesh = new Mesh(geometry, material);

        waterUniforms = material.uniforms;

        this.#plane_mesh.rotation.x = -Math.PI / 2;
        this.#plane_mesh.matrixAutoUpdate = false;
        this.#plane_mesh.updateMatrix();

        this.#scene.add(this.#plane_mesh)

        gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, this.#renderer);

        if (this.#renderer.capabilities.isWebGL2 === false) {

            gpuCompute.setDataType(HalfFloatType);

        }

        const heightmap0 = gpuCompute.createTexture();

        this.fillTexture(heightmap0);

        heightmapVariable = gpuCompute.addVariable('heightmap', heightmapFragmentShader, heightmap0);

        gpuCompute.setVariableDependencies(heightmapVariable, [heightmapVariable]);

        heightmapVariable.material.uniforms['mousePos'] = {value: new Vector2(10000, 10000)};
        heightmapVariable.material.uniforms['mouseSize'] = {value: 20.0};
        heightmapVariable.material.uniforms['viscosityConstant'] = {value: 0.98};
        heightmapVariable.material.uniforms['heightCompensation'] = {value: 0};
        heightmapVariable.material.defines.BOUNDS = BOUNDS.toFixed(1);

        const error = gpuCompute.init();
        if (error !== null) {

            console.error(error);

        }

        // Create compute shader to smooth the water surface and velocity
        smoothShader = gpuCompute.createShaderMaterial(smoothFragmentShader, {smoothTexture: {value: null}});

        // Create compute shader to read water level
        readWaterLevelShader = gpuCompute.createShaderMaterial(readWaterLevelFragmentShader, {
            point1: {value: new Vector2()},
            levelTexture: {value: null}
        });
        readWaterLevelShader.defines.WIDTH = WIDTH.toFixed(1);
        readWaterLevelShader.defines.BOUNDS = BOUNDS.toFixed(1);

        // Create a 4x1 pixel image and a render target (Uint8, 4 channels, 1 byte per channel) to read water height and orientation
        readWaterLevelImage = new Uint8Array(4 * 1 * 4);
        //
        readWaterLevelRenderTarget = new WebGLRenderTarget(4, 1, {
            wrapS: ClampToEdgeWrapping,
            wrapT: ClampToEdgeWrapping,
            minFilter: NearestFilter,
            magFilter: NearestFilter,
            format: RGBAFormat,
            type: UnsignedByteType,
            depthBuffer: false
        });

    }

    /**
     * Build stats to display fps
     */
    setStats() {
        this.#stats = new Stats()
        this.#stats.showPanel(0)
        document.body.appendChild(this.#stats.dom)
    }

    setGUI() {
        const titleEl = document.querySelector('.main-title')

        const handleChange = () => {
            this.#mesh.position.y = this.#guiObj.y
            titleEl.style.display = this.#guiObj.showTitle ? 'block' : 'none'
        }

        const gui = new GUI()
        gui.add(this.#guiObj, 'y', -3, 3).onChange(handleChange)
        gui.add(this.#guiObj, 'showTitle').name('show title').onChange(handleChange)
    }

    /**
     * List of events
     */
    events() {
        window.addEventListener('resize', this.handleResize, {passive: true})
        this.draw(0)
    }

    // EVENTS

    /**
     * Request animation frame function
     * This function is called 60/time per seconds with no performance issue
     * Everything that happens in the scene is drawed here
     * @param {Number} now
     */
    draw = () => {
        // now: time in ms
        this.#stats.begin()

        if (this.#controls) this.#controls.update() // for damping
        this.#renderer.render(this.#scene, this.#camera)

        this.#stats.end()
        this.raf = window.requestAnimationFrame(this.draw)
    }

    /**
     * On resize, we need to adapt our camera based
     * on the new window width and height and the renderer
     */
    handleResize = () => {
        this.#width = window.innerWidth
        this.#height = window.innerHeight

        // Update camera
        this.#camera.aspect = this.#width / this.#height
        this.#camera.updateProjectionMatrix()

        const DPR = window.devicePixelRatio ? window.devicePixelRatio : 1

        this.#renderer.setPixelRatio(DPR)
        this.#renderer.setSize(this.#width, this.#height)
    }
    fillTexture = (texture) => {

        const waterMaxHeight = 10;

        function noise(x, y) {

            let multR = waterMaxHeight;
            let mult = 0.025;
            let r = 0;
            for (let i = 0; i < 15; i++) {

                r += multR * simplex.noise(x * mult, y * mult);
                multR *= 0.53 + 0.025 * i;
                mult *= 1.25;

            }

            return r;

        }

        const pixels = texture.image.data;

        let p = 0;
        for (let j = 0; j < WIDTH; j++) {

            for (let i = 0; i < WIDTH; i++) {

                const x = i * 128 / WIDTH;
                const y = j * 128 / WIDTH;

                pixels[p + 0] = noise(x, y);
                pixels[p + 1] = pixels[p + 0];
                pixels[p + 2] = 0;
                pixels[p + 3] = 1;

                p += 4;

            }

        }

    }
}
