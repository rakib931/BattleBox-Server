require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRIT_KEYS);
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
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
  // console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    // console.log(decoded);
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
    const ordersCollection = db.collection("participants");
    const submittionCollection = db.collection("submition");
    const winnersCollection = db.collection("winners");
    const usersCollection = db.collection("users");
    const reviewsCollection = db.collection("reviews");
    const contestCreatorReqCollection = db.collection("contest-creator-req");

    // admin middleware
    const verifyADMIN = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin")
        return res
          .status(403)
          .send({ message: "Admin only Actions!", role: user?.role });

      next();
    };
    // creator middleware
    const verifyCREATOR = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "creator")
        return res
          .status(403)
          .send({ message: "Seller only Actions!", role: user?.role });

      next();
    };
    // payment endpoients
    app.post("/create-checkout-section", async (req, res) => {
      const paymentInfo = req.body;
      // console.log(paymentInfo);
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.contestName,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          contestId: paymentInfo?.contestId,
          customar: paymentInfo?.customer.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/contest/${paymentInfo?.contestId}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/contests/${paymentInfo?.contestId}`,
      });
      res.send({ url: session.url });
    });
    // payment success
    app.post("/payments-success", async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const contest = await contestCollection.findOne({
        _id: new ObjectId(session.metadata.contestId),
      });

      const order = await ordersCollection.findOne({
        transactionId: session.payment_intent,
      });
      if (session.status === "complete" && contest && !order) {
        const orderInfo = {
          contestId: session.metadata.contestId,
          deadline: contest.deadline,
          transactionId: session.payment_intent,
          customer: session.metadata.customar,
          saller: contest?.saller,
          contestName: contest.contestName,
          category: contest.category,
          instruction: contest.instruction,
          price: session.amount_total / 100,
          prizeMoney: contest.prizeMoney,
          image: contest?.image,
        };
        const result = await ordersCollection.insertOne(orderInfo);

        // update contest participent
        await contestCollection.updateOne(
          {
            _id: new ObjectId(session.metadata.contestId),
          },
          {
            $inc: { participent: 1 },
          }
        );
        const userQuery = session.metadata.customar;
        await usersCollection.updateOne(
          { email: userQuery },
          {
            $inc: { participated: 1 },
          }
        );
        res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,
        });
      }
    });
    // participeted api for participent
    app.get("/participated", verifyJWT, async (req, res) => {
      const result = await ordersCollection
        .find()
        .sort({ deadline: 1 })
        .toArray();
      res.send(result);
    });
    // Task submit api
    app.post("/submit-task", verifyJWT, async (req, res) => {
      const taskData = req.body;
      const contestId = taskData.contestId;
      const customerEmail = taskData.customerEmail; // or req.user.email / userId

      const isExist = await submittionCollection.findOne({
        contestId: contestId,
        customerEmail: customerEmail,
      });
      if (isExist) return res.send("Task Already Submited");
      const result = await submittionCollection.insertOne(taskData);
      res.send("Task Submited", result);
    });
    // submition get for creator
    app.get(
      "/creators-submition/:id",
      verifyJWT,
      verifyCREATOR,
      async (req, res) => {
        const contestId = req.params.id;
        const email = req.tokenEmail;

        const result = await submittionCollection
          .find({
            customerEmail: email,
            contestId: contestId,
          })
          .toArray();

        res.send(result);
      }
    );
    // submition get for user
    app.get("/submited-task", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const result = await submittionCollection
        .find({ customerEmail: email })
        .toArray();
      res.send(result);
    });
    // winner post api for contest creators
    app.post("/add-winner", verifyJWT, verifyCREATOR, async (req, res) => {
      const winnerData = req.body;
      const contestId = winnerData.contestId;
      const isExist = await winnersCollection.findOne({ contestId: contestId });
      if (isExist) return res.send("Already Decleared Winner");

      const result = await winnersCollection.insertOne(winnerData);
      const winner = {
        name: winnerData.winnerName,
        image: winnerData.winnerImage,
        prize: winnerData.prize,
      };
      // console.log(winner);
      // return;
      await contestCollection.updateOne(
        { _id: new ObjectId(contestId) },
        { $set: { winner } }
      );
      const userQuery = winnerData.winnerEmail;
      await usersCollection.updateOne(
        { email: userQuery },
        {
          $inc: { win: 1 },
        }
      );
      // console.log("updated");
      res.send("Winner Decleared", result);
    });
    // winned collection get for patticipatent
    app.get("/contest-winned", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const result = await winnersCollection
        .find({ winnerEmail: email })
        .toArray();
      res.send(result);
    });
    // winners for home page
    app.get("/winners", async (req, res) => {
      const result = await winnersCollection.find().toArray();
      res.send(result);
    });
    // users for leaderboard
    app.get("/leaderboard-users", verifyJWT, async (req, res) => {
      const limit = Number(req.query.limit) || 10;
      const skip = Number(req.query.skip) || 0;

      const users = await usersCollection
        .find()
        .sort({ win: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      const count = await usersCollection.countDocuments();
      res.send({ users, total: count });
    });
    // get a singel user for profile
    app.get("/user-profile", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const result = await usersCollection.findOne({ email: email });
      res.send(result);
    });
    // contest post db api
    app.post("/contests", verifyJWT, verifyCREATOR, async (req, res) => {
      const contestData = req.body;
      // console.log(contestData);
      // return
      const result = await contestCollection.insertOne(contestData);
      res.send(result);
    });
    // contest update api
    app.patch(
      "/contest-update/:id",
      verifyJWT,
      verifyCREATOR,
      async (req, res) => {
        const id = req.params.id;
        const contestData = req.body;
        const update = {
          $set: contestData,
        };
        const query = { _id: new ObjectId(id) };
        const result = await contestCollection.updateOne(query, update);
        res.send(result);
      }
    );
    //  delete contest for creator
    app.delete(
      "/constest-delete",
      verifyJWT,
      verifyCREATOR,
      async (req, res) => {
        const { id } = req.body;

        const result = await contestCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      }
    );
    // contests get for contest creator
    app.get(
      "/contest-inventory",
      verifyJWT,
      verifyCREATOR,
      async (req, res) => {
        const email = req.tokenEmail;
        const result = await contestCollection
          .find({ saller: email })
          .toArray();
        res.send(result);
      }
    );
    // contests get for admin
    app.get("/pending-contests", verifyJWT, verifyADMIN, async (req, res) => {
      const result = await contestCollection
        .find({ status: "pending" })
        .toArray();
      res.send(result);
    });
    // update  contest for admin
    app.patch("/update-status", verifyJWT, verifyADMIN, async (req, res) => {
      const { id, status } = req.body;
      const result = await contestCollection.updateOne(
        {
          _id: new ObjectId(id),
        },
        { $set: { status } }
      );
      res.send(result);
    });
    //  delete contest for admin
    app.delete(
      "/constest-delete-admin",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        const { id } = req.body;

        const result = await contestCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      }
    );
    // contests get for participient with category
    app.get("/approved-contest/:category", async (req, res) => {
      const category = req.params.category;
      let query = { category, status: "approved" };
      const result = await contestCollection.find(query).toArray();
      res.send(result);
    });
    // contests get for participient withOut category
    app.get("/approved-contest", async (req, res) => {
      let query = { status: "approved" };
      const result = await contestCollection.find(query).toArray();
      res.send(result);
    });
    // contests for home page highest participated
    app.get("/popular-contests", async (req, res) => {
      let query = { status: "approved" };
      const result = await contestCollection
        .find(query)
        .sort({ participent: -1 })
        .limit(8)
        .toArray();
      res.send(result);
    });
    // contest get for banner with search
    app.get("/banner-contest/:query", async (req, res) => {
      const searchQuery = req.params.query;

      if (!searchQuery || searchQuery === "") {
        return res.send([]);
      }

      const query = {
        status: "approved",
        category: {
          $regex: searchQuery,
          $options: "i",
        },
      };

      const result = await contestCollection.find(query).toArray();
      res.send(result);
    });
    // contest data get for details page
    app.get("/contest/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const email = req.tokenEmail;
      const result = await contestCollection.findOne({ _id: new ObjectId(id) });
      const isPaid = await ordersCollection.findOne(
        { contestId: id },
        { customer: email }
      );
      console.log(id, isPaid);
      res.send({
        contest: result,
        isPaid: !!isPaid,
      });
    });
    // post a contest provider request
    app.post("/contest-creator-req", verifyJWT, async (req, res) => {
      const providerReqData = req.body;
      const isExist = await contestCreatorReqCollection.findOne({
        email: providerReqData?.email,
      });
      if (isExist)
        return res.status(403).send({
          messege: "your request is already submited wait for approve",
        });
      const result = await contestCreatorReqCollection.insertOne(
        providerReqData
      );
      res.send(result);
    });
    // get all contest provider request for admin
    app.get("/manage-creator-req", verifyJWT, verifyADMIN, async (req, res) => {
      const result = await contestCreatorReqCollection.find().toArray();
      res.send(result);
    });
    // update role contest creator request for admin
    app.patch("/update-role", verifyJWT, verifyADMIN, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } }
      );
      await contestCreatorReqCollection.deleteOne({ email });
      res.send(result);
    });
    // user saved in db
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.last_login = new Date().toISOString();
      userData.role = "participent";
      userData.participated = Number(0);
      userData.win = Number(0);
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
    // get all user for admin
    app.get("/users", verifyJWT, verifyADMIN, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection
        .find({ email: { $ne: adminEmail } })
        .toArray();
      res.send(result);
    });
    // get users role by email
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });
    // post a review
    app.post("/add-review", verifyJWT, async (req, res) => {
      const review = req.body;
      const result = await reviewsCollection.insertOne(review);
      res.send(result);
    });
    // get reviews for home
    app.get("/get-review", async (req, res) => {
      const result = await reviewsCollection
        .find()
        .sort({ _id: -1 })
        .limit(8)
        .toArray();
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
