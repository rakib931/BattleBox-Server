require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("BattleBox");
    const contestCollection = db.collection("contests");
    const usersCollection = db.collection("users");
    const contestCreatorReqCollection = db.collection("contest-Creator-req");
    const contestCreator = db.collection("contest-creator");

    // post a contest provider request
    app.post("/contest-prov-req", async (req, res) => {
      const providerReqData = req.body;
      console.log(providerReqData);
      // return;
      const isExist = await contestProvReqCollection.findOne({
        email: providerReqData?.email,
      });
      if (isExist)
        return res.status(403).send({
          messege: "your request is already submited wait for approve",
        });
      const result = await contestProvReqCollection.insertOne(providerReqData);
      res.send(result);
    });
    // get all contest provider for admin
    app.get("/manage-creator-req", async (req, res) => {
      const result = await contestCreatorReqCollection.find().toArray();
      res.send(result);
    });
    // user saved in db
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.last_login = new Date().toISOString();
      userData.role = "participent";

      const query = {
        email: userData.email,
      };
      const alreadyExist = await usersCollection.findOne(query);

      console.log("user already exist", !!alreadyExist);

      if (alreadyExist) {
        console.log("Updating user Info.....");
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_login: new Date().toISOString(),
          },
        });
        return res.send(result);
      }
      console.log("Saving new user Info.....");
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
