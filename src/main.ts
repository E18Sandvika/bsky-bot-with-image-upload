import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { IncomingMessage } from 'http';
import { spawnSync } from 'child_process';
import { AtpAgent } from '@atproto/api';
dotenv.config();

const todayFolder = 'today';
const imageFileName = 'today_image.jpg';
const imageUrl = 'https://kamera.atlas.vegvesen.no/api/images/0229009_1';
const bskyHandle = process.env["BSKY_HANDLE"];
const bskyPassword = process.env["BSKY_PASSWORD"];

async function downloadImage(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode === 302 && response.headers.location) {
        https.get(response.headers.location, (redirectedResponse) => {
          saveImageToFile(redirectedResponse, dest, resolve, reject);
        }).on('error', reject);
      } else if (response.statusCode === 200) {
        saveImageToFile(response, dest, resolve, reject);
      } else {
        reject(new Error(`Failed to download image. Status Code: ${response.statusCode}`));
      }
    }).on('error', reject);
  });
}

function saveImageToFile(response: IncomingMessage, dest: string, resolve: () => void, reject: (err: Error) => void): void {
  const file = fs.createWriteStream(dest);
  response.pipe(file);
  file.on('finish', () => {
    file.close(resolve);
  });
  file.on('error', (err) => {
    fs.unlink(dest, () => reject(err));
  });
}

async function getImageDescription(): Promise<string> {
  const imageFilePath = path.join(todayFolder, imageFileName);
  if (!fs.existsSync(imageFilePath)) {
    console.error(`Image file not found: ${imageFilePath}`);
    return "Kamerabilde — trafikk og værtilstand ulest.";
  }
  const prompt = "Describe this traffic camera image in less than 200 characters in Norwegian, mentioning weather and traffic conditions:";
  console.log(`Calling copilot CLI with model auto, attachment: ${imageFilePath}`);
  const proc = spawnSync('copilot', [
    '--model', 'auto',
    '-p', prompt,
    '--attachment', imageFilePath,
    '--no-ask-user'
  ], {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (proc.error) {
    console.error("Copilot CLI spawn error:", proc.error.message);
    return "Kamerabilde — trafikk og værtilstand ulest.";
  }
  if (proc.status !== 0) {
    const stderr = (proc.stderr as Buffer).toString().trim();
    const stdout = (proc.stdout as Buffer).toString().trim();
    console.error(`Copilot CLI exited with code ${proc.status}`);
    if (stdout) console.error("stdout:", stdout);
    if (stderr) console.error("stderr:", stderr);
    return "Kamerabilde — trafikk og værtilstand ulest.";
  }
  const output = (proc.stdout as Buffer).toString().trim();
  console.log("Copilot description received:", output);
  return output || "Kamerabilde — trafikk og værtilstand ulest.";
}

function getImageDataUrl(imageFile: string, imageFormat: string): string {
  try {
    const imageBuffer = fs.readFileSync(imageFile);
    const imageBase64 = imageBuffer.toString('base64');
    return `data:image/${imageFormat};base64,${imageBase64}`;
  } catch {
    console.error(`Could not read '${imageFile}'.`);
    process.exit(1);
  }
}

function convertDataURIToUint8Array(dataURI: string): Uint8Array {
  const byteString = atob(dataURI.split(',')[1]);
  const arrayBuffer = new ArrayBuffer(byteString.length);
  const uint8Array = new Uint8Array(arrayBuffer);
  for (let i = 0; i < byteString.length; i++) {
    uint8Array[i] = byteString.charCodeAt(i);
  }
  return uint8Array;
}

async function getPostText(): Promise<string> {
  if (!fs.existsSync(todayFolder)) {
    fs.mkdirSync(todayFolder);
  }
  if (!bskyHandle || !bskyPassword) {
    throw new Error("Bluesky handle or password is not defined");
  }
  const imageDest = path.join(todayFolder, imageFileName);
  try {
    await downloadImage(imageUrl, imageDest);
    console.log(`Image downloaded to: ${imageDest}`);
  } catch {
    console.error("Error downloading the image.");
    return "Error downloading the image.";
  }
  let imageDescription: string;
  try {
    imageDescription = await getImageDescription() || "No description available.";
    console.log("Image description received:", imageDescription);
  } catch {
    console.error("Error getting image description.");
    return "Error getting image description.";
  }
  const maxGraphemes = 300;
  if (imageDescription.length > maxGraphemes) {
    imageDescription = imageDescription.slice(0, maxGraphemes) + '...';
  }
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: bskyHandle, password: bskyPassword });
  const imageDataUrl = getImageDataUrl(imageDest, 'jpg');
  const { data } = await agent.uploadBlob(convertDataURIToUint8Array(imageDataUrl), { encoding: 'image/jpeg' });
  await agent.post({
    text: imageDescription,
    embed: {
      $type: 'app.bsky.embed.images',
      images: [
        {
          alt: imageDescription,
          image: data.blob,
          aspectRatio: { width: 1000, height: 500 }
        }
      ]
    },
    createdAt: new Date().toISOString()
  });
  return `${imageDescription}\n![Image](${imageUrl})`;
}

async function main() {
  try {
    const text = await getPostText();
    console.log(`[${new Date().toISOString()}] Posted: "${text}"`);
  } catch (error) {
    console.error("Error posting to Bluesky:", error);
  }
}
main();
