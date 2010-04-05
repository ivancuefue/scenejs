/**
 * Services geometry node requests to store and render elements of geometry.
 *
 * Stores geometry in vertex buffers in video RAM, caching them there under a least-recently-used eviction policy
 * mediated by the "memory" backend.
 *
 * Geometry elements are identified  by type strings, which may either be supplied by scene nodes, or automatically
 * generated by this backend.
 *
 * After creating geometry, the backend returns to the node a handle to the geometry for the node to retain. The node
 * can then pass in the handle to test if the geometry still exists (perhaps it has been evicted) or to have the
 * backend render the geometry.
 *
 * The backend is free to evict whatever geometry it chooses between scene traversals, so the node must always check
 * the existence of the geometry and possibly request its re-creation each time before requesting the backend render it.
 *
 * A geometry buffer consists of positions, normals, optional texture coordinates, indices and a primitive type
 * (eg. "triangles").
 *
 * When rendering a geometry element, the backend will first fire a SHADER_ACTIVATE to prompt the shader backend
 * to ensure that the shader backend has composed and activated a shader. The shader backend will then fire
 * SHADER_ACTIVATED to marshal resources for its script variables from various backends, which then provide their
 * resources to the shader through XXX_EXPORTED events. This backend then likewise provides its geometry buffers to the
 * shader backend through a GEOMETRY_EXPORTED event, then bind and draw the index buffer.
 *
 * The backend avoids needlessly re-exporting and re-binding geometry (eg. when rendering a bunch of cubes in a row)
 * by tracking the ID of the last geometry rendered. That ID is maintained until another either geoemetry is rendered,
 * the canvas switches, shader deactivates or scene deactivates. While the ID is non-null, the corresponding geometry
 * cannot be evicted from the cache.
 */
SceneJS._backends.installBackend(

        "geometry",

        function(ctx) {

            var time = (new Date()).getTime();               // For LRU caching
            var canvas;
            var geometries = {};
            var nextTypeId = 0;     // For random geometry type when no type specified
            var currentBoundGeo;    // ID of geometry last rendered, non-null while that geometry loaded

            ctx.events.onEvent(
                    SceneJS._eventTypes.TIME_UPDATED,
                    function(t) {
                        time = t;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.SCENE_ACTIVATED,
                    function() {
                        canvas = null;
                        currentBoundGeo = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.CANVAS_ACTIVATED,
                    function(c) {
                        canvas = c;
                        currentBoundGeo = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.CANVAS_DEACTIVATED,
                    function() {
                        canvas = null;
                        currentBoundGeo = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.SHADER_ACTIVATED,
                    function() {
                        currentBoundGeo = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.SHADER_DEACTIVATED,
                    function() {
                        currentBoundGeo = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.RESET,
                    function() {
                        for (var geoId in geometries) {
                            destroyGeometry(geometries[geoId]);
                        }
                        canvas = null;
                        geometries = {};
                        currentBoundGeo = null;
                    });

            /**
             * Destroys geometry, returning true if memory freed, else false
             * where canvas not found and geometry was implicitly destroyed
             */
            function destroyGeometry(geo) {
                ctx.logging.debug("Destroying geometry : '" + geo.type + "'");
                if (geo.geoId == currentBoundGeo) {
                    currentBoundGeo = null;
                }
                if (document.getElementById(geo.canvas.canvasId)) { // Context won't exist if canvas has disappeared
                    if (geo.vertexBuf) {
                        geo.vertexBuf.destroy();
                    }
                    if (geo.normalBuf) {
                        geo.normalBuf.destroy();
                    }
                    if (geo.normalBuf) {
                        geo.indexBuf.destroy();
                    }
                    if (geo.texCoordBuf) {
                        geo.texCoordBuf.destroy();
                    }
                }
                geometries[geo.geoId] = null;
            }

            /**
             * Volunteer to destroy a shader when asked to by
             * memory management module when memory runs low
             */
            ctx.memory.registerEvictor(
                    function() {
                        var earliest = time;
                        var evictee;
                        for (var geoId in geometries) {
                            if (geoId) {
                                var geo = geometries[geoId];
                                if (geo.lastUsed < earliest
                                        && document.getElementById(geo.canvas.canvasId)) {
                                    evictee = geo;
                                    earliest = geo.lastUsed;
                                }
                            }
                        }
                        if (evictee) {
                            ctx.logging.warn("Evicting geometry from shader memory: " + evictee.type);
                            destroyGeometry(evictee);
                            return true;
                        }
                        return false;   // Couldnt find suitable geo to delete
                    });

            /**
             * Creates an array buffer
             *
             * @param context WebGL context
             * @param type Eg. ARRAY_BUFFER
             * @param values WebGL array
             * @param numItems
             * @param itemSize
             * @param usage Eg. STATIC_DRAW
             */
            function createArrayBuffer(description, context, type, values, numItems, itemSize, usage) {
                var buf;
                ctx.memory.allocate(
                        description,
                        function() {
                            buf = new SceneJS._webgl.ArrayBuffer
                                    (context, type, values, numItems, itemSize, usage);
                        });
                return buf;
            }

            /**
             * Converts SceneJS primitive type string to WebGL constant
             */
            function getPrimitiveType(context, type) {
                switch (type) {
                    case "points":
                        return context.POINTS;
                    case "lines":
                        return context.LINES;
                    case "line-loop":
                        return context.LINE_LOOP;
                    case "line-strip":
                        return context.LINE_STRIP;
                    case "triangles":
                        return context.TRIANGLES;
                    case "triangle-strip":
                        return context.TRIANGLE_STRIP;
                    case "triangle-fan":
                        return context.TRIANGLE_FAN;
                    default:
                        throw new SceneJS.exceptions.InvalidGeometryConfigException(
                                "Unsupported geometry primitive: '" +
                                type +
                                "' - supported types are: 'points', 'lines', 'line-loop', " +
                                "'line-strip', 'triangles', 'triangle-strip' and 'triangle-fan'");
                }
            }

            return { // Node-facing API

                /**
                 * Returns the ID of the geometry of the given type if it exists on the active canvas
                 */
                findGeometry : function(type) {
                    if (!canvas) {
                        throw new SceneJS.exceptions.NoCanvasActiveException("No canvas active");
                    }
                    var geoId = canvas.canvasId + ":" + type;
                    return (geometries[geoId]) ? geoId : null;
                },

                /**
                 * Creates geometry of the given type on the active canvas and returns its ID
                 *
                 * @param type Optional type for geometry - when null, a random type will be used
                 * @param data Contains positions, normals, indexes etc.
                 */
                createGeometry : function(type, data) {
//                    if (!type) {
//                        type = "g" + nextTypeId++;
//                    }
//
                    ctx.logging.debug("Creating geometry: '" + type + "'");
                    if (!canvas) {
                        throw new SceneJS.exceptions.NoCanvasActiveException("No canvas active");
                    }

                    if (!data.primitive) { // "points", "lines", "line-loop", "line-strip", "triangles", "triangle-strip" or "triangle-fan"
                        throw new SceneJS.exceptions.NodeConfigExpectedException("Geometry node parameter expected : primitive");
                    }

                    var geoId = canvas.canvasId + ":" + type;
                    var context = canvas.context;

                    var usage = context.STATIC_DRAW;
                    //var usage = (!data.fixed) ? context.STREAM_DRAW : context.STATIC_DRAW;

                    var vertexBuf;
                    var normalBuf;
                    var texCoordBuf;
                    var indexBuf;

                    try { // TODO: Modify usage flags in accordance with how often geometry is evicted

                        vertexBuf = createArrayBuffer("geometry vertex buffer", context, context.ARRAY_BUFFER,
                                new WebGLFloatArray(data.positions), data.positions.length, 3, usage);

                        normalBuf = createArrayBuffer("geometry normal buffer", context, context.ARRAY_BUFFER,
                                new WebGLFloatArray(data.normals), data.normals.length, 3, usage);

                        if (data.uv) {
                            texCoordBuf = createArrayBuffer("geometry texture buffer", context, context.ARRAY_BUFFER,
                                    new WebGLFloatArray(data.uv), data.uv.length, 2, usage);
                        }

                        indexBuf = createArrayBuffer("geometry index buffer", context, context.ELEMENT_ARRAY_BUFFER,
                                new WebGLUnsignedShortArray(data.indices), data.indices.length, 1, usage);

                        var geo = {
                            fixed : true, // TODO: support dynamic geometry
                            primitive: getPrimitiveType(context, data.primitive),
                            type: type,
                            geoId: geoId,
                            lastUsed: time,
                            canvas : canvas,
                            context : context,
                            vertexBuf : vertexBuf,
                            normalBuf : normalBuf,
                            indexBuf : indexBuf,
                            texCoordBuf: texCoordBuf
                        };

                        geometries[geoId] = geo;

                        return geoId;

                    } catch (e) { // Allocation failure - delete whatever buffers got allocated

                        if (vertexBuf) {
                            vertexBuf.destroy();
                        }
                        if (normalBuf) {
                            normalBuf.destroy();
                        }
                        if (texCoordBuf) {
                            texCoordBuf.destroy();
                        }
                        if (indexBuf) {
                            indexBuf.destroy();
                        }
                        throw e;
                    }
                },

                /**
                 * Draws the geometry of the given ID that exists on the current canvas.
                 * Client node must ensure prior that the geometry exists on the canvas
                 * using findGeometry, and have created it if neccessary with createGeometry.
                 */
                drawGeometry : function(geoId) {
                    if (!canvas) {
                        throw new SceneJS.exceptions.NoCanvasActiveException("No canvas active");
                    }

                    ctx.events.fireEvent(SceneJS._eventTypes.SHADER_ACTIVATE);

                    var geo = geometries[geoId];

                    geo.lastUsed = time;

                    var context = canvas.context;


                    /* Dont re-export and bind if already the last one exported and bound - this is the case when
                     * we're drawing a batch of the same object, Eg. a bunch of cubes in a row
                     */
                    if (currentBoundGeo != geoId) {
                        for (var i = 0; i < 8; i++) {
                            context.disableVertexAttribArray(i);
                        }
                        ctx.events.fireEvent(
                                SceneJS._eventTypes.GEOMETRY_EXPORTED,
                                geo);

                        geo.indexBuf.bind(); // Bind index buffer

                        currentBoundGeo = geoId;
                    }

                    /* Draw geometry
                     */

                    context.drawElements(geo.primitive, geo.indexBuf.numItems, context.UNSIGNED_SHORT, 0);
                    context.flush();

                    /* Don't need to unbind buffers - only one is bound at a time anyway                    
                     */

                    /* Destroy one-off geometry
                     */
                    if (!geo.fixed) {
                        destroyGeometry(geo);
                        currentBoundGeo = null;
                    }

                }
            };
        });