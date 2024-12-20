var app = new Vue({
    el: '#app',
    data: {
        connected: false,
        ros: null,
        logs: [],
        loading: false,
        rosbridge_address: 'wss://i-0b828debc071b3ba0.robotigniteacademy.com/66ffc49c-840e-4946-9d03-15ed1991b311/rosbridge/',
        port: '9090',
        interval: null,
        recording: false,
        mediaRecorder: null,
        dragging: false,
        x: 'no',
        y: 'no',
        dragCircleStyle: {
            margin: '0px',
            top: '0px',
            left: '0px',
            display: 'none',
            width: '100px',
            height: '100px',
        },
        joystick: {
            vertical: 0,
            horizontal: 0,
        },
        pubInterval: null,
        mapToOdom: null,
        robotPose: null,
        lastMapMessage: null,
        // Task tracker
        currentTask: null,
        // If currentTask is 0, we show success under Last Run
        lastRunSuccess: false,
        // Publishers
        commandPub: null,
        elevatorUpPub: null,
        elevatorDownPub: null,
    },
    computed: {
        // Compute the name of the current task based on integer
        currentTaskName() {
            if (this.currentTask === 1) return "Searching";
            if (this.currentTask === 2) return "Attaching";
            if (this.currentTask === 3) return "Delivering";
            if (this.currentTask === 4) return "Returning to Home";
            return "";
        },
        // Disable controls if current task is 2 or 3
        disableControls() {
            return (this.currentTask === 2 || this.currentTask === 3);
        }
    },
    methods: {
        connect: function() {
            this.loading = true
            this.ros = new ROSLIB.Ros({
                url: this.rosbridge_address
            })
            this.ros.on('connection', () => {
                // Log connection
                this.logs.unshift((new Date()).toTimeString() + ' - Connected to WebSocket!')
                this.connected = true
                this.loading = false
                // publisher for joystick
                this.pubInterval = setInterval(this.publish, 100)

                // Command publisher
                this.commandPub = new ROSLIB.Topic({
                    ros: this.ros,
                    name: '/command_topic',
                    messageType: 'std_msgs/msg/Int32'
                });

                // Elevator publishers
                this.elevatorUpPub = new ROSLIB.Topic({
                    ros: this.ros,
                    name: '/elevator_up',
                    messageType: 'std_msgs/msg/String'
                });
                this.elevatorDownPub = new ROSLIB.Topic({
                    ros: this.ros,
                    name: '/elevator_down',
                    messageType: 'std_msgs/msg/String'
                });

                // Subscribe to /map
                const mapTopic = new ROSLIB.Topic({
                    ros: this.ros,
                    name: '/map',
                    messageType: 'nav_msgs/msg/OccupancyGrid'
                });
                mapTopic.subscribe((message) => {
                    this.lastMapMessage = message;
                    this.renderMap(message);
                });

                // Subscribe to tf
                const tfTopic = new ROSLIB.Topic({
                    ros: this.ros,
                    name: '/tf_relay',
                    messageType: 'tf2_msgs/msg/TFMessage'
                });
                tfTopic.subscribe((tfMsg) => {
                    for (const t of tfMsg.transforms) {
                        if (t.header.frame_id === "map" && t.child_frame_id === "robot_odom") {
                            this.mapToOdom = t.transform;
                        }
                    }
                });

                // Subscribe to odom
                const odomTopic = new ROSLIB.Topic({
                    ros: this.ros,
                    name: '/odom',
                    messageType: 'nav_msgs/msg/Odometry'
                });
                odomTopic.subscribe((odomMsg) => {
                    const {x: ox, y: oy, z: oz} = odomMsg.pose.pose.position;
                    const {x: qx, y: qy, z: qz, w: qw} = odomMsg.pose.pose.orientation;

                    if (this.mapToOdom) {
                        const transformed = this.transformPose(
                            ox, oy, oz, qx, qy, qz, qw,
                            this.mapToOdom.translation.x,
                            this.mapToOdom.translation.y,
                            this.mapToOdom.translation.z,
                            this.mapToOdom.rotation.x,
                            this.mapToOdom.rotation.y,
                            this.mapToOdom.rotation.z,
                            this.mapToOdom.rotation.w
                        );
                        this.robotPose = transformed;
                        if (this.lastMapMessage) {
                            this.renderMap(this.lastMapMessage);
                        }
                    }
                });

                // ********** Subscribe to /current_task **********
                const currentTaskTopic = new ROSLIB.Topic({
                    ros: this.ros,
                    name: '/current_task',
                    messageType: 'std_msgs/msg/Int32'
                });

                currentTaskTopic.subscribe((msg) => {
                    const value = msg.data;
                    this.handleCurrentTaskUpdate(value);
                });

            })

            this.ros.on('error', (error) => {
                this.logs.unshift((new Date()).toTimeString() + ` - Error: ${error}`)
            })
            this.ros.on('close', () => {
                // Log disconnection
                this.logs.unshift((new Date()).toTimeString() + ' - Disconnected from WebSocket!')
                this.connected = false
                this.loading = false
                clearInterval(this.pubInterval)
            })
        },
        disconnect: function() {
            this.ros.close()
        },
        // Handle current_task updates
        handleCurrentTaskUpdate(value) {
            // Log the event with the event name
            let eventName = "";
            let definedValues = [0,1,2,3,4];
            switch(value) {
                case 0: eventName = "Completed/Success"; break;
                case 1: eventName = "Searching"; break;
                case 2: eventName = "Attaching"; break;
                case 3: eventName = "Delivering"; break;
                case 4: eventName = "Returning to Home"; break;
                default: eventName = "_";
            }

            this.logs.unshift((new Date()).toTimeString() + ` - Received /current_task: ${eventName}`);

            if (!definedValues.includes(value)) {
                this.currentTask = null;
                return;
            }

            this.currentTask = value;

            // If 0 is received, show success and keep it until 1 is received
            if (value === 0) {
            this.lastRunSuccess = true;
            } else if (value === 1) {
                // Receiving 1 clears the success message
                this.lastRunSuccess = false;
            }
        },
        // Publish joystick commands if not disabled
        publish: function() {
            // If controls are disabled due to currentTask = 2 or 3, do not publish
            if (this.disableControls) return;

            if (this.joystick.vertical !== 0 || this.joystick.horizontal !== 0) {
                let topic = new ROSLIB.Topic({
                    ros: this.ros,
                    name: '/cmd_vel',
                    messageType: 'geometry_msgs/msg/Twist'
                })
                let message = new ROSLIB.Message({
                    linear: {
                        x: 0.3 * this.joystick.vertical,
                        y: 0,
                        z: 0
                    },
                    angular: {
                        x: 0,
                        y: 0,
                        z: -this.joystick.horizontal
                    },
                })
                topic.publish(message)
            }
        },
        // Command publishing on button click
        sendCommand(cmdValue) {
            if (!this.commandPub) return;
            this.commandPub.publish({data: cmdValue});

            // Log the event with the event name
            let eventName = "";
            switch(cmdValue) {
                case 0: eventName = "Stop System"; break;
                case 1: eventName = "Start Search"; break;
                case 2: eventName = "Return to Home"; break;
            }

            this.logs.unshift((new Date()).toTimeString() + ` - Sent to /command_topic: ${eventName}`);
        },
        // Elevator commands
        elevatorUp() {
            if (!this.elevatorUpPub) return;
            this.elevatorUpPub.publish({data: ""});
            this.logs.unshift((new Date()).toTimeString() + ' - Sent Elevator Up');
        },
        elevatorDown() {
            if (!this.elevatorDownPub) return;
            this.elevatorDownPub.publish({data: ""});
            this.logs.unshift((new Date()).toTimeString() + ' - Sent Elevator Down');
        },

        // Joystick
        startDrag(event) {
            this.dragging = true
            if (event.type === 'touchstart') {
                event.preventDefault();
                let touch = event.touches[0];
                let rect = event.target.getBoundingClientRect();
                this.x = touch.clientX - rect.left;
                this.y = touch.clientY - rect.top;
            } else {
                this.x = event.offsetX;
                this.y = event.offsetY;
            }
        },
        stopDrag() {
            this.dragging = false
            this.x = this.y = 'no'
            this.dragCircleStyle.display = 'none'
            this.resetJoystickVals()
        },
        doDrag(event) {
            if (this.dragging) {
                if (event.type === 'touchmove') {
                    event.preventDefault();
                    let touch = event.touches[0];
                    let rect = event.target.getBoundingClientRect();
                    this.x = touch.clientX - rect.left;
                    this.y = touch.clientY - rect.top;
                } else {
                    this.x = event.offsetX;
                    this.y = event.offsetY;
                }

                let ref = document.getElementById('dragstartzone');
                this.dragCircleStyle.display = 'inline-block';

                let centerX = 100; 
                let centerY = 100; 
                let distance = Math.sqrt(Math.pow(this.x - centerX, 2) + Math.pow(this.y - centerY, 2));
                let radius = 100; 
                if (distance > radius) {
                    let angle = Math.atan2(this.y - centerY, this.x - centerX);
                    this.x = centerX + radius * Math.cos(angle);
                    this.y = centerY + radius * Math.sin(angle);
                }

                let minTop = ref.offsetTop - parseInt(this.dragCircleStyle.height) / 2;
                let top = this.y + minTop;
                this.dragCircleStyle.top = `${top}px`;

                let minLeft = ref.offsetLeft - parseInt(this.dragCircleStyle.width) / 2;
                let left = this.x + minLeft;
                this.dragCircleStyle.left = `${left}px`;

                this.setJoystickVals();
            }
        },
        setJoystickVals() {
            this.joystick.vertical = -1 * ((this.y / 200) - 0.5)
            this.joystick.horizontal = ((this.x / 200) - 0.5)
        },
        resetJoystickVals() {
            this.joystick.vertical = 0
            this.joystick.horizontal = 0
        },

        // Voice methods unchanged
        async startRecording() {
            const stream = await navigator.mediaDevices.getUserMedia({audio: true});
            this.mediaRecorder = new MediaRecorder(stream);
            const audioChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                audioChunks.push(event.data);
            };

            this.mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunks, {type: "audio/webm"});
                this.sendAudioToROS(audioBlob);
            };

            this.mediaRecorder.start();
            this.recording = true;
        },
        stopRecording() {
            if (this.mediaRecorder) {
                this.mediaRecorder.stop();
                this.recording = false;
            }
        },
        sendAudioToROS(audioBlob) {
            const reader = new FileReader();
            reader.onload = () => {
                const audioData = reader.result; 
                const audioTopic = new ROSLIB.Topic({
                    ros: this.ros,
                    name: "/web_audio_input",
                    messageType: "std_msgs/msg/String",
                });
                const audioMessage = new ROSLIB.Message({data: audioData});
                audioTopic.publish(audioMessage);
            };
            reader.readAsDataURL(audioBlob);
        },

        // Transform utilities unchanged
        transformPose(poseX, poseY, poseZ, poseQx, poseQy, poseQz, poseQw,
            transX, transY, transZ, transQx, transQy, transQz, transQw) {
            const rotated = this.rotateVectorByQuaternion(poseX, poseY, poseZ, transQx, transQy, transQz, transQw);
            const mapX = rotated.x + transX;
            const mapY = rotated.y + transY;
            const mapZ = rotated.z + transZ;
            const combinedQ = this.multiplyQuaternions(transQx, transQy, transQz, transQw, poseQx, poseQy, poseQz, poseQw);
            return {
                x: mapX,
                y: mapY,
                z: mapZ,
                qx: combinedQ.qx,
                qy: combinedQ.qy,
                qz: combinedQ.qz,
                qw: combinedQ.qw
            };
        },
        rotateVectorByQuaternion(x, y, z, qx, qy, qz, qw) {
            const qvx = qw * x + qy * z - qz * y;
            const qvy = qw * y + qz * x - qx * z;
            const qvz = qw * z + qx * y - qy * x;
            const qvw = -qx * x - qy * y - qz * z;

            return {
                x: qvw * (-qx) + qvx * qw - qvy * qz + qvz * qy,
                y: qvw * (-qy) + qvy * qw - qvz * qx + qvx * qz,
                z: qvw * (-qz) + qvz * qw - qvx * qy + qvy * qx
            };
        },
        multiplyQuaternions(q1x, q1y, q1z, q1w, q2x, q2y, q2z, q2w) {
            return {
                qx: q1w * q2x + q1x * q2w + q1y * q2z - q1z * q2y,
                qy: q1w * q2y + q1y * q2w + q1z * q2x - q1x * q2z,
                qz: q1w * q2z + q1z * q2w + q1x * q2y - q1y * q2x,
                qw: q1w * q2w - q1x * q2x - q1y * q2y - q1z * q2z
            };
        },
        renderMap: function(message) {
            const canvas = document.getElementById('map');
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const mapWidth = message.info.width;
            const mapHeight = message.info.height;
            const resolution = message.info.resolution;
            const originX = message.info.origin.position.x;
            const originY = message.info.origin.position.y;
            const data = message.data;

            const scaleX = canvas.width / mapWidth;
            const scaleY = canvas.height / mapHeight;
            const scale = Math.min(scaleX, scaleY);

            const offsetX = (canvas.width - mapWidth * scale) / 2;
            const offsetY = (canvas.height - mapHeight * scale) / 2;

            const imageData = new ImageData(mapWidth, mapHeight);
            for (let i = 0; i < data.length; i++) {
                const value = data[i];
                let color;
                if (value === -1) color = [200, 200, 200];
                else if (value === 0) color = [255, 255, 255];
                else color = [0, 0, 0];

                const x = i % mapWidth;
                const y = Math.floor(i / mapWidth);
                const flippedY = (mapHeight - 1) - y;
                const idx = (flippedY * mapWidth + x) * 4;

                imageData.data[idx] = color[0];
                imageData.data[idx + 1] = color[1];
                imageData.data[idx + 2] = color[2];
                imageData.data[idx + 3] = 255;
            }

            const offCanvas = document.createElement('canvas');
            offCanvas.width = mapWidth;
            offCanvas.height = mapHeight;
            const offCtx = offCanvas.getContext('2d');
            offCtx.putImageData(imageData, 0, 0);

            ctx.drawImage(offCanvas, 0, 0, mapWidth, mapHeight, offsetX, offsetY, mapWidth * scale, mapHeight * scale);

            if (this.robotPose) {
                const {x: robotX, y: robotY, qx, qy, qz, qw} = this.robotPose;
                const pixelX = (robotX - originX) / resolution;
                const pixelY = (robotY - originY) / resolution;
                const flippedPixelY = (mapHeight - 1) - pixelY;

                const canvasX = offsetX + pixelX * scale;
                const canvasY = offsetY + flippedPixelY * scale;

                const yaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
                const correctedYaw = -yaw + Math.PI / 2;

                ctx.save();
                ctx.translate(canvasX, canvasY);
                ctx.rotate(correctedYaw);
                ctx.fillStyle = 'red';
                ctx.beginPath();
                ctx.moveTo(0, -20);
                ctx.lineTo(-12, 12);
                ctx.lineTo(12, 12);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
            }
        },
    },
    mounted() {
        this.interval = setInterval(() => {
            if (this.ros != null && this.ros.isConnected) {
                console.log("Connected to ROS 2.");
            }
        }, 10000);
        window.addEventListener('mouseup', this.stopDrag);
        window.addEventListener('touchend', this.stopDrag)
        window.addEventListener('touchcancel', this.stopDrag)
    },
    beforeDestroy() {
        window.removeEventListener('mouseup', this.stopDrag)
        window.removeEventListener('touchend', this.stopDrag)
        window.removeEventListener('touchcancel', this.stopDrag)
        clearInterval(this.interval)
    },
})
