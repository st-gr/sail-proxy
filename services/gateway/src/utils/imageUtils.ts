import axios from 'axios';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

/**
 * Download an image from a URL and convert it to Base64
 * @param imageUrl - The URL of the image to download
 * @returns Base64 encoded image
 */
export const downloadAndEncodeImage = async (imageUrl: string): Promise<string> => {
  try {
    logger.info('ImageUtils', `Downloading image from URL: ${imageUrl}`);
    
    // Download the image as an array buffer
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer'
    });
    
    // Convert the array buffer to a base64 string
    const base64Image = Buffer.from(response.data).toString('base64');
    logger.info('ImageUtils', 'Image successfully converted to Base64');
    
    return base64Image;
  } catch (error: any) {
    logger.error('ImageUtils', `Error downloading or encoding image: ${error.message}`);
    throw new Error(`Failed to process image from URL: ${error.message}`);
  }
};

/**
 * Determine the media type (MIME type) from a URL
 * @param url - The image URL
 * @returns The media type
 */
export const getMediaTypeFromUrl = (url: string): string => {
  // Default to image/jpeg if we can't determine
  let mediaType = 'image/jpeg';
  
  // Try to determine media type from file extension
  if (url.endsWith('.png')) {
    mediaType = 'image/png';
  } else if (url.endsWith('.jpg') || url.endsWith('.jpeg')) {
    mediaType = 'image/jpeg';
  } else if (url.endsWith('.gif')) {
    mediaType = 'image/gif';
  } else if (url.endsWith('.webp')) {
    mediaType = 'image/webp';
  }
  
  return mediaType;
};