import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { IncomingMessage } from 'http';
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
  try {
    const { execSync } = await import('child_process');
    const prompt = "Describe this traffic camera image in less than 200 characters in Norwegian, mentioning weather and traffic conditions:";
    const output = execSync(
      `copilot --model auto -p "${prompt}" --attachment "${imageFilePath}" --no-ask-user 2>&1`,
      { encoding: 'utf8', timeout: 60000 }
    ).trim();
    console.log("Copilot description received:", output);
    return output || "Kamerabilde — trafikk og værtilstand ulest.";
  } catch (err: any) {
    console.error("Copilot CLI error:", err.message?.split('\n')[0]);
    return "Kamerabilde — trafikk og værtilstand ulest.";
  }
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
  // Ensure the 'today' folder exists
  if (!fs.existsSync(todayFolder)) {
    fs.mkdirSync(todayFolder);
  }
  if (!bskyHandle || !bskyPassword) {
    throw new Error("Bluesky handle or password is not defined");
  }
  // Step 1: Download the image to the 'today' folder
  const imageDest = path.join(todayFolder, imageFileName);
  try {
    await downloadImage(imageUrl, imageDest);
    console.log(`Image downloaded to: ${imageDest}`);
  } catch {
    console.error("Error downloading the image.");
    return "Error downloading the image.";
  }
  // Step 2: Get image description from Copilot CLI
  let imageDescription: string;
  try {
    imageDescription = await getImageDescription() || "No description available.";
    console.log("Image description received:", imageDescription);
  } catch {
    console.error("Error getting image description.");
    return "Error getting image description.";
  }
  // Truncate the description to 300 graphemes
  const maxGraphemes = 300;
  if (imageDescription.length > maxGraphemes) {
    imageDescription = imageDescription.slice(0, maxGraphemes) + '...';
  }
  // Step 3: Upload the image as a blob to Bluesky
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: bskyHandle, password: bskyPassword });
  const imageDataUrl = getImageDataUrl(imageDest, 'jpg');
  const { data } = await agent.uploadBlob(convertDataURIToUint8Array(imageDataUrl), { encoding: 'image/jpeg' });
  // Step 4: Create a post with the image embedded
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
