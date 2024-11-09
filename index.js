import express from 'express';
import 'dotenv/config';
import cors from 'cors';
import path from 'path';
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { SignModel } from './Schema/Post.js';
import SessionModel from './Schema/Session.js';
import MainRoute from './Routes/Main.js';
import { lstat } from "fs";
import cookieParser from 'cookie-parser';
import SMSRoute from './Routes/SMS.js';
import connection from './DB/db.js';
import PackageDetails from "./Routes/Package.js";
import sendVerificationEmail from './emailService.js'; // Import the email service
const PORT = process.env.PORT || 3437;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(cookieParser());
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
await connection();
const sessionMiddleware = async (req, res, next) => {
    // Define paths that should be excluded from session verification
    const excludedPaths = [
        "/signin",
        "/signup",
        "/verify-email",
        "/resend-verification"
    ];
    // If the request path is in the excluded paths, skip session check
    if (excludedPaths.includes(req.path.toLowerCase())) {
        return next();
    }
    try {
        // Get sessionId from cookies or headers
        const sessionId = req.cookies.sessionId || req.header("Authorization");
        if (!sessionId) {
            return res.status(401).redirect("/signin");
        }
        // Find the session in the database
        const session = await SessionModel.findOne({ sessionId });
        if (!session) {
            return res.status(401).redirect("/signin");
        }
        // Check if the session is expired
        if (new Date() > session.expiresAt) {
            await SessionModel.findByIdAndDelete(session._id); // Delete expired session
            return res.status(401).redirect("/signin");
        }
        // Attach session data to the request object (e.g., userId)
        res.locals.user = await SignModel.findById(session.userId); // Attach user to request
        // Proceed to the next middleware or route handler
        next();
    }
    catch (error) {
        console.error("Session verification error:", error);
        res.status(500).send("Internal Server Error");
    }
};
app.use(sessionMiddleware);
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.post("/signup", async (req, res) => {
    const { Name, Email, Password, Role, Organization, PhoneNumber } = req.body;
    try {
        // Validate required fields
        if (!Name || !Email || !Password || !Role || !Organization || !PhoneNumber) {
            return res.status(400).send("Error: Missing fields");
        }
        // Hash the password
        const hashedPassword = await bcrypt.hash(Password, 10);
        const token = uuidv4(); // Use UUID or any unique token generator
        const hashed = await bcrypt.hash(token, 10);
        const verificationToken = hashed;
        // Create the new user
        const newUser = new SignModel({
            id: uuidv4(),
            Name,
            Email,
            Password: hashedPassword,
            PhoneNumber,
            Role,
            Organization,
            verificationToken: verificationToken,
            verificationTokenExpiry: new Date(Date.now() + 3600000),
            isVerified: false, // User is not verified initially
        });
        await newUser.save();
        // Send verification email
        await sendVerificationEmail(Email, verificationToken);
        console.log("A verification link has been sent to your email. Please check your inbox or spam folder.");
        res.redirect('/');
    }
    catch (error) {
        console.error("Error during signup:", error);
        res.status(500).send("Internal Server Error");
    }
});
app.get("/signin", (req, res) => {
    res.sendFile(path.resolve(__dirname, "./Views/signin.html"));
});
app.post('/signin', async (req, res) => {
    const { Email, Password } = req.body;
    try {
        if (!Email || !Password) {
            return res.status(400).send('Error: Missing fields');
        }
        const user = await SignModel.findOne({ Email });
        if (!user || !user.Password) {
            console.log('User or Password not found');
            return res.status(401).send('Error: Invalid email or password');
        }
        // Ensure Password and user.Password are strings before comparing
        const isMatch = await bcrypt.compare(Password, user.Password);
        if (!isMatch) {
            console.log('Password does not match');
            return res.status(401).send('Error: Invalid password');
        }
        if (user.Role === "Admin") {
            return res.status(401).send('Error: You are not a User');
        }
        if (user.isVerified) {
            const sessionId = uuidv4();
            const session = new SessionModel({
                userId: user._id,
                sessionId,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 3600000), // 1 hour
            });
            await session.save();
            res.cookie("sessionId", sessionId, { httpOnly: true, secure: true });
            res.redirect('/');
        }
        else {
            res.redirect('/signup');
        }
    }
    catch (error) {
        console.error('Error during login:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.post("/reset-Session", async (req, res) => {
    const sessionId = req.cookies.sessionId;
    if (sessionId) {
        await SessionModel.findOneAndDelete({ sessionId });
        res.clearCookie("sessionId");
    }
    res.status(200).send("Session reset");
});
app.post('/user', async (req, res) => {
    if (!res.locals.user) {
        return res.status(401).send("Unauthorized");
    }
    const usere = res.locals.user;
    try {
        const Id = usere._id;
        const user = await SignModel.findById(Id);
        if (!user) {
            console.log('User not found');
            return res.status(401).send('Error: Invalid email');
        }
        const data = {
            Name: user.Name,
            Email: user.Email,
            Password: user.Password,
            PackageName: user.Details?.PackageName,
            Coins: user.Details?.Coins
        };
        res.send(data);
    }
    catch (error) {
        console.error('Error during user data fetch:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.use('/', MainRoute);
app.use('/sms', SMSRoute);
app.use('/buypackage', PackageDetails);
const arrey = [];
app.post('/recoverpass', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await SignModel.findOne({ Email: email });
        if (!user) {
            console.log('User not found');
            return res.status(401).send('Invalid email address. Please try again.');
        }
        const Id = user._id;
        function generateTemporaryPassword(length = 10) {
            const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let password = '';
            for (let i = 0; i < length; i++) {
                const randomIndex = Math.floor(Math.random() * characters.length);
                password += characters[randomIndex];
            }
            return password;
        }
        // Example usage
        const temporaryPassword = generateTemporaryPassword(12);
        const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
        arrey.push(hashedPassword);
        const FORVERIFICATION = arrey[0];
        const updatedUser = await SignModel.findByIdAndUpdate(Id, {
            $set: {
                "Password": arrey[0],
                "verificationToken": FORVERIFICATION,
                "verificationTokenExpiry": Date.now() + 3600000,
                "isVerified": false
            }
        }, { new: true, runValidators: true });
        updatedUser?.save();
        await sendVerificationEmail(email, FORVERIFICATION);
        if (!updatedUser) {
            return res.status(500).send('Failed to update the password. Please try again.');
        }
        console.log(`Temporary password for ${email}: ${hashedPassword}`);
        res.send({
            message: `A verification link has been sent to your email. Please copy and save the temporary password provided password: ${temporaryPassword}.`,
        });
    }
    catch (error) {
        console.error('Error in /recoverpass:', error);
        res.status(500).send('An internal server error occurred. Please try again later.');
    }
});
app.get('/verify-email', async (req, res) => {
    const { token } = req.query;
    if (!token) {
        return res.status(400).send('Verification token is required.');
    }
    try {
        // Find the user with the matching verification token and check if it's still valid
        const user = await SignModel.findOne({
            verificationToken: token,
            verificationTokenExpiry: { $gt: Date.now() }
        });
        if (!user) {
            return res.status(400).send('Invalid or expired token.');
        }
        // Mark the user as verified
        user.isVerified = true;
        // Clear the token expiry
        await user.save();
        // const redirectToken = uuidv4();
        // const hash = await bcrypt.hash(redirectToken , 10);
        // OneTime.push(hash)
        // res.redirect('/');
        res.send('Email verified successfully!');
    }
    catch (error) {
        console.error("Error verifying email:", error);
        res.status(500).send('Server error');
    }
});
app.post('/resend-verification', async (req, res) => {
    const { Email } = req.body;
    try {
        const user = await SignModel.findOne({ Email });
        if (!user) {
            return res.status(404).send('Error: User not found');
        }
        if (user.isVerified) {
            return res.status(400).send('Error: Email is already verified');
        }
        const token = uuidv4(); // Use UUID or any unique token generator
        const hashed = await bcrypt.hash(token, 10);
        const verificationToken = hashed;
        user.verificationToken = hashed,
            user.verificationTokenExpiry = new Date(Date.now() + 3600000);
        user.save();
        await sendVerificationEmail(Email, verificationToken);
        res.status(200).send('Verification email sent');
    }
    catch (error) {
        console.error('Error resending verification email:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.use("*", (req, res) => {
    res.status(404).sendFile(path.resolve(__dirname, './Views/page-404.html'));
});
lstat;
export default app;
