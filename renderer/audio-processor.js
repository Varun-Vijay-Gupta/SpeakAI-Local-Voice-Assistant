/**
 * AudioWorklet: forwards raw mono PCM frames (128 samples each) to the renderer,
 * which batches them into fixed-size chunks for Whisper.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
    }
    return true; // keep the processor alive
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
