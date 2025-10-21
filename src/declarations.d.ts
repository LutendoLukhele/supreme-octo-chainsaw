declare module 'csv-parser';
declare module 'mammoth';
declare module 'pdf-parse';
declare module 'marked';

declare global {
    namespace Express {
        namespace Multer {
            interface File {
                /** Field name specified in the form */
                fieldname: string;
                /** Name of the file on the user's computer */
                originalname: string;
                /** Encoding type of the file */
                encoding: string;
                /** Mime type of the file */
                mimetype: string;
                /** Size of the file in bytes */
                size: number;
                /** The folder to which the file has been saved (if configured) */
                destination: string;
                /** The name of the file within the destination (if configured) */
                filename: string;
                /** The full path to the uploaded file */
                path: string;
                /** A Buffer of the entire file (if configured) */
                buffer: Buffer;
            }
        }
    }
}