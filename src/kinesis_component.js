import React, { useEffect, useRef } from "react";
import AWS from "aws-sdk";
import {
  KinesisVideoWebRTCStorageClient,
  JoinStorageSessionCommand
} from "@aws-sdk/client-kinesis-video-webrtc-storage";
import { SignalingClient, Role } from "amazon-kinesis-video-streams-webrtc";

const streamName = "stream_name";
const region = "region_name";
const accessKeyId = "access_key_id";
const secretAccessKey = "secret_access_key";
const channelName = "channel_name";

const peerConnectionByClientId = {};

function randomString() {
  return Date.now().toString();
}

const KinesisVideoStream = () => {
  const videoRef = useRef(null);
  const signalingClientRef = useRef(null);
  const localStreamRef = useRef(null);

  useEffect(() => {
    const initKinesisVideoStream = async () => {
      // Create a Kinesis Video Streams client
      const kinesisVideoClient = new AWS.KinesisVideo({
        accessKeyId,
        secretAccessKey,
        region,
        correctClockSkew: true
      });

      try {
        // Get stream ARN
        const describeStreamResponse = await kinesisVideoClient
          .describeStream({ StreamName: streamName })
          .promise();
        const streamARN = describeStreamResponse.StreamInfo.StreamARN;
        console.log("[MASTER] Stream ARN:", streamARN);

        // Get signaling channel ARN
        const describeSignalingChannelResponse = await kinesisVideoClient
          .describeSignalingChannel({
            ChannelName: channelName
          })
          .promise();
        const channelARN = describeSignalingChannelResponse.ChannelInfo.ChannelARN;
        console.log("[MASTER] Channel ARN:", channelARN);

        await kinesisVideoClient
          .updateMediaStorageConfiguration({
            ChannelARN: channelARN,
            MediaStorageConfiguration: {
              Status: "ENABLED",
              StreamARN: streamARN
            }
          })
          .promise();

        const getSignalingChannelEndpointResponse = await kinesisVideoClient
          .getSignalingChannelEndpoint({
            ChannelARN: channelARN,
            SingleMasterChannelEndpointConfiguration: {
              Protocols: ["WSS", "HTTPS", "WEBRTC"],
              Role: Role.MASTER
            }
          })
          .promise();
        const endpointsByProtocol = getSignalingChannelEndpointResponse.ResourceEndpointList.reduce(
          (endpoints, endpoint) => {
            endpoints[endpoint.Protocol] = endpoint.ResourceEndpoint;
            return endpoints;
          },
          {}
        );
        console.log("[MASTER] Endpoints:", endpointsByProtocol);
        const kinesisVideoSignalingChannelsClient = new AWS.KinesisVideoSignalingChannels({
          region,
          accessKeyId,
          secretAccessKey,
          endpoint: endpointsByProtocol.HTTPS,
          correctClockSkew: true
        });

        const getIceServerConfigResponse = await kinesisVideoSignalingChannelsClient
          .getIceServerConfig({
            ChannelARN: channelARN
          })
          .promise();
        const iceServers = [{ urls: `stun:stun.kinesisvideo.${region}.amazonaws.com:443` }];
        getIceServerConfigResponse.IceServerList.forEach(iceServer =>
          iceServers.push({
            urls: iceServer.Uris,
            username: iceServer.Username,
            credential: iceServer.Password
          })
        );

        console.log("[MASTER] ICE servers:", iceServers);
        const signalingClient = new SignalingClient({
          channelARN,
          channelEndpoint: endpointsByProtocol.WSS,
          // clientId,
          role: Role.MASTER,
          region,
          credentials: {
            accessKeyId,
            secretAccessKey
          },
          systemClockOffset: kinesisVideoClient.config.systemClockOffset
        });
        signalingClientRef.current = signalingClient;

        // Initialize the local video stream
        const localVideo = videoRef.current;

        const localStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true
        });
        localStreamRef.current = localStream;
        localVideo.srcObject = localStream;

        signalingClient.on("open", async () => {
          const kinesisVideoWebrtcStorageClient = new KinesisVideoWebRTCStorageClient({
            region: region,
            credentials: {
              accessKeyId: accessKeyId,
              secretAccessKey: secretAccessKey
            },
            // sessionToken: sessionToken,
            endpoint: endpointsByProtocol.WEBRTC,
            maxAttempts: 10
          });
          const input = {
            channelArn: channelARN
          };
          console.log(input);
          const command = new JoinStorageSessionCommand(input);
          const response = await kinesisVideoWebrtcStorageClient.send(command);
          console.dir(response);

          // Get a stream from the webcam, add it to the peer connection, and display it in the local view
          // const peerConnection = new RTCPeerConnection({ iceServers });
          // try {
          //   localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
          //   localVideo.srcObject = localStream;
          // } catch (e) {
          //   // Could not find webcam
          //   return;
          // }
          // const offer = await peerConnection.createOffer({
          //   offerToReceiveAudio: false,
          //   offerToReceiveVideo: true
          // });
          // await peerConnection.setLocalDescription(offer);
          // signalingClient.sendSdpOffer(peerConnection.localDescription);
        });

        // When an ICE candidate is received from the master, add it to the peer connection.
        signalingClient.on("iceCandidate", (candidate, remoteClientId) => {
          console.log("Received ICE candidate from client " + remoteClientId);
          peerConnectionByClientId[remoteClientId].addIceCandidate(candidate);
        });

        signalingClient.on("sdpOffer", async (sdpOffer, remoteClientId) => {
          console.log("Received SDP offer from client " + remoteClientId);
          console.log("Received offer ", sdpOffer);

          if (
            peerConnectionByClientId[remoteClientId] &&
            peerConnectionByClientId[remoteClientId].connectionState !== "closed"
          ) {
            peerConnectionByClientId[remoteClientId].close();
          }

          const peerConnection = new RTCPeerConnection({ iceServers, iceTransportPolicy: "all" });
          peerConnectionByClientId[remoteClientId] = peerConnection;

          localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

          peerConnection.addEventListener("connectionstatechange", async event => {
            console.log("CONNECTION STATE CHANGE");
            console.dir(event);
            if (streamARN && event.target.connectionState === "connected") {
              console.log("Connection to peer successful!");
              console.log(
                "[MASTER] Successfully joined the storage session. Media is being recorded to",
                streamARN
              );
            }
          });
          peerConnection.addEventListener("icecandidate", ({ candidate }) => {
            if (candidate) {
              console.log("[MASTER] Generated ICE candidate for client", remoteClientId);
              console.log("ICE candidate: ", candidate);
              console.log("[MASTER] Sending SDP answer to client", remoteClientId);
              signalingClient.sendIceCandidate(candidate);
            } else {
              // No more ICE candidates will be generated
              // signalingClient.sendSdpAnswer(peerConnection.localDescription);
            }
          });

          await peerConnection.setRemoteDescription(sdpOffer);

          await peerConnection.setLocalDescription(
            await peerConnection.createAnswer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: true
            })
          );

          const correlationId = randomString();
          signalingClient.sendSdpAnswer(
            peerConnection.localDescription,
            remoteClientId,
            correlationId
          );

          console.log("[MASTER] Generating ICE candidates for client", remoteClientId);
        });

        signalingClient.on("close", () => {
          console.log("[MASTER] Disconnected from signaling channel");
        });

        signalingClient.on("error", error => {
          console.error("[MASTER] Signaling client error", error);
        });

        signalingClient.open();
      } catch (error) {
        console.error("Error:", error);
      }
    };

    initKinesisVideoStream();
    return () => {
      if (signalingClientRef.current) {
        signalingClientRef.current.close();
      }
      Object.keys(peerConnectionByClientId).forEach(clientId => {
        peerConnectionByClientId[clientId].close();
        delete peerConnectionByClientId[clientId];
      });
      // peerConnectionByClientId = {};
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  return (
    <div>
      <video ref={videoRef} width="640" height="480" autoPlay playsInline></video>
    </div>
  );
};

export default KinesisVideoStream;
