import { MongoClient,ObjectId } from "mongodb";
import express from 'express';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import session from 'express-session';
import bcrypt from 'bcrypt';
import connectStore from 'connect-mongodb-session';
import moment from 'moment'


//sessions to kolekcja uzywana do logowania 
const MongoDBStore = connectStore(session);

const store = new MongoDBStore({
    uri: "mongodb://localhost:27017/",
    databaseName: "RestaurantDataBaseProject",
    collection: "Sessions"
}, function(error) {
    if (error) console.error(error);
});

store.on('error', function(error) {
    console.error(error);
});


//tworzenie aplikacji
const app = express();

app.use(morgan('dev'));
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.set('view engine', 'pug');

app.use(session({
    secret: 'mySecretKey',
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
}));

//podlaczanie naszej bazy danych 
const client = new MongoClient("mongodb://localhost:27017/");
await client.connect();

const db = client.db("RestaurantDataBaseProject");
const dishesCollection = db.collection("Dishes");
const clientsCollection = db.collection("Clients");
const cartsCollection = db.collection("Carts");
const reservationsCollection = db.collection("Reservations");
const ordersCollection = db.collection("Orders");
const adminsCollection = db.collection("Admins");


//warunek bycia zalogowanym uzywany potem np przy wyswietlaniu koszyka
const requireLogin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

const checkAdmin = (req,res,next) => {
    if(req.session.isAdmin){
        return res.redirect('/admin');
    }
    next();
};


//strona rejestracji
app.get('/register', (req, res) => {
    res.render('register');
});

//operacja rejestracji
app.post('/register', async (req, res) => {
    const { name, surname, email, password, phone, address } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    await clientsCollection.insertOne({ name,surname,email, password: hashedPassword, phone, address, history: [],reservations: [] });
    res.redirect('/login');
});


app.get('/login', (req, res) => {
    res.render('login');
});

//operacja logowania 
// jesli poprawne haslo przenosi nas na strone glowna 
// jesli haslo niepoprawne jestesmy nadal na stronie logowania
app.post('/login', async (req, res) => {
    const { name,surname, password } = req.body;
    let user = await clientsCollection.findOne({ name, surname });

    //jesli nie znalezlismy uzytkownika w kolekcji clientow to sprwadzamy w adminach
    if(!user){
        user = await adminsCollection.findOne({name,surname});
        if(user && user.password === password){
            req.session.userId = user._id;
            req.session.isAdmin = true;
            return res.redirect('/admin');
        }

    }else if (user && await bcrypt.compare(password, user.password)) {
        req.session.userId = user._id;
        req.session.isAdmin = false;
        return res.redirect('/');
    }

    return res.redirect('/login');
});

//wylogowywanie
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            if(req.session.isAdmin){
                return res.redirect('/admin')
            }else{
                return res.redirect('/');
            }
            
        }
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

//strona glowna
app.get('/', requireLogin,checkAdmin, async (req, res) => {
    
    //pobieramy wszystkie dania z kolekcji "Dishes"
    const dishes = await dishesCollection.find({}).toArray(); 

    //przekazujemy tablice dań do pliku index.pug który będzie renderowany na stronie
    res.render('index', {dishes: dishes});
});

app.get('/reservations', requireLogin, async (req, res) => {

    //z Sessions pobieramy ID naszego użytkownika żebyśmy wiedzieli kogo rezerwacje wyświetlić
    const userId = req.session.userId;

    //Znajdz klienta o danym id w kolekcji Clients
    const client = await clientsCollection.findOne({_id: new ObjectId(userId)}); 

    // przypisz rezerwacje klienta do tablicy 
    const reservationData = client.reservations;

    //przekaz tablice do pliku reservations.pug
    res.render('reservations', { reservationData });
});

app.post('/makereservation', requireLogin, async(req,res) =>{

    //z Sessions pobieramy ID naszego użytkownika 
    const userId = req.session.userId;

    //pobieramy godzine,czas i ilosc miejsc
    const {date,time,people} = req.body;


    //sprawdzanie czy nie ma juz za duzo rezerwacji na ta sama godzine 
    const dateTime = moment(`${date} ${time}`, 'YYYY-MM-DD HH:mm');

    const oneHourEarlier = dateTime.clone().subtract(1, 'hour');    
    const oneHourLater = dateTime.clone().add(1, 'hour');
    
    const reservationsInRange = await reservationsCollection.find({
        date: date,
        time: {
            $gte: oneHourEarlier.format('HH:mm'), 
            $lte: oneHourLater.format('HH:mm') 
        },
        isCanceled: 0
    }).toArray();

    let occupiedPlaces = reservationsInRange.reduce((total,reservation) => {
        return total + parseInt(reservation.people);
    },0);


    const placesLeft = 20 - occupiedPlaces;

    if(placesLeft < parseInt(people)){
        return res.redirect('/reservations');
    }

    const client = await clientsCollection.findOne({_id: new ObjectId(userId)});

    //dodajemy rezerwacje do kolekcji rezerwacji
    const reservationRes = await reservationsCollection.insertOne({client: client,date: date,time: time,people: people,isCanceled: 0});

    //pobieramy rezerwacje ktora dodalismy 
    const reservationToAdd = await reservationsCollection.findOne({_id: reservationRes.insertedId})

    //pobrana rezerwacje dodajemy rowniez do listy rezerwacji naszego uzytkownika
    await clientsCollection.updateOne(
        {_id: new ObjectId(userId)},
        {$push: {reservations: reservationToAdd}}
    );

    res.redirect('/reservations');
    
});



app.post('/cancelreservation',requireLogin, async(req,res) =>{
    //z Sessions pobieramy ID naszego użytkownika 
    const userId = req.session.userId;

    //pobieramy ID rezerwacji
    const {reservationID} = req.body;

    //w kolekcji rezerwacji ustawaimy status rezerwacji na canceled
    await reservationsCollection.updateOne({_id: new ObjectId(reservationID)}, {$set: {isCanceled: 1}});

    //znajdujemy naszego klienta
    const client = await clientsCollection.findOne({_id: new ObjectId(userId)});

    //lista rezerwacji naszego klienta
    const newReservations = client.reservations;

    //znajdujemy rezerwacje ktora chcemy usunać
    const index = client.reservations.findIndex(element => element._id.toString() === reservationID);

    if(index !== -1){
        //usuwamy rezerwacje z listy
        newReservations.splice(index,1);

        //podmieniamy starą liste na nową
        await clientsCollection.updateOne({_id:new ObjectId(userId)},{$set: {reservations: newReservations}});

        return res.status(200).json({ success: true, message: 'Reservation is canceled!' });

    }else{
        return res.status(500).json({ success: false, message: 'Couldnt cancel reservation' });
    }

});

app.get('/cart', requireLogin, async (req, res) => {
    //z Sessions pobieramy ID naszego użytkownika żebyśmy wiedzieli kogo koszyk wyswietlic
    const userId = req.session.userId;


    //znajdz koszyk w kolekcji Carts o numerze clienta_id równym id naszego uzytkownika 
    const cart = await cartsCollection.findOne({client_id: new ObjectId(userId)}); 

    //jesli nie znaleźlismy koszyka to znaczy że nie istnieje wiec tworzymy dodajemy nowy koszyk do kolekcji
    if(!cart){
        await cartsCollection.insertOne({client_id: new ObjectId(userId),dishes: []})
    }
    
    const newCart = await cartsCollection.findOne({client_id: new ObjectId(userId)});

    //przypisz dania z koszyka do tabliy
    const cartItems = newCart.dishes;

    //przekaz tablice do pliku cart.pug
    res.render('cart', { cartItems });
});

app.post('/addtocart', requireLogin, async(req,res) => {
    try{
        //z Sessions pobieramy ID naszego użytkownika 
        const userId = req.session.userId;

        //znajdujemy naszego uzytkownika w kolekcji clients
        const client = await clientsCollection.findOne({_id: new ObjectId(userId)});
    
        if (!client) {
            return res.status(404).json({ success: false, message: 'Client not found' });
        }
    
        //znajdujemy koszyk naszego klienta w kolekcji Carts
        const clientCart = await cartsCollection.findOne({client_id: client._id});

        //pobieramy ID dania z wyslanego requesta
        const {dishID} = req.body;

        //znajdujemy nasze danie w kolekcji Dishes
        const dish = await dishesCollection.findOne({_id: new ObjectId(dishID)});
    
        if (!dish) {
            return res.status(404).json({ success: false, message: 'Dish not found' });
        }
        
        //dodajmy znalezione danie do koszyka naszego uzytkownika 
    
        if(!clientCart){
            await cartsCollection.insertOne({client_id: client._id,dishes: [dish]})
        }else{
            await cartsCollection.updateOne({client_id: client._id},{$push: {dishes: dish}});
        }
    
        return res.status(200).json({ success: true, message: 'Item added to cart!' });

    } catch(error){
        console.error('Error adding to cart:', error);
        return res.status(500).json({ success: false, message: 'An error occurred while adding the item to the cart.' });
    }
   
});

app.post('/clearcart',requireLogin, async(req,res) => {
    try{
        //z Sessions pobieramy ID naszego użytkownika 
        const userId = req.session.userId;
        
        //ustawiamy zawartosc koszyka naszego uzytkownika na pusta tablice
        await cartsCollection.updateOne(
            {client_id: new ObjectId(userId)},
            {$set: { dishes: [] } }
        )

        return res.status(200).json({ success: true, message: 'Cart cleared!' });
    }catch(error){
        console.error('Error clearing cart:', error);
        return res.status(500).json({ success: false, message: 'An error occurred while clearing the cart.' });
    }
     
});


app.post('/deleteproduct',requireLogin, async(req,res) => {
    //z Sessions pobieramy ID naszego użytkownika 
    const userId = req.session.userId;

    //znajdujemy koszyk naszego uzytkownika 
    const cartToUpdate = await cartsCollection.findOne({client_id: new ObjectId(userId)})

    //lista dan w koszyku
    const itemList = cartToUpdate.dishes;

    //pobieramy ID dania ktory chcemy usunac z koszyka 
    const {itemID} = req.body;

    //znajdujemy przedmiot ktory chcemy usunac w liście dań
    const index = itemList.findIndex(item => item._id.toString() === itemID);

    if(index !== -1){
        //usuwamy danie z listy
        itemList.splice(index,1);

        //zamieniamy stara liste dań na nową z usuniętym daniem
        await cartsCollection.updateOne({client_id: new ObjectId(userId)},{ $set: { dishes: itemList }});
        return res.status(200).json({ success: true, message: 'Item deleted!' });

    }else{
        return res.status(500).json({ success: false, message: 'Item not found' });
    }


});

app.post('/makeorder',requireLogin, async(req,res) => {
    try{
        //z Sessions pobieramy ID naszego użytkownika 
        const userId = req.session.userId;

        //znajdujemy koszyk naszego klienta
        const cart = await cartsCollection.findOne({client_id: new ObjectId(userId)});

        //znajdujemy naszego klienta
        const client = await clientsCollection.findOne({_id: new ObjectId(userId)});

        //jesli koszyk jest pusty to zwracamy blad 
        if(cart.dishes.length === 0){
            return res.status(500).json({ success: false, message: 'Cart empty' });
        }

        //obliczamy cenę zamówienia 
        let orderPrice = cart.dishes.reduce((total,dish) => total += dish.price, 0);

        const date = new Date().toISOString().split('T')[0];

        //dodajemy zamowienie do kolekcji orders
        const orderRes = await ordersCollection.insertOne({client: client, date: date, cart_id: cart._id, dishes: cart.dishes, price: orderPrice, address: client.address, status: "pending" });

        const orderToAdd = await ordersCollection.findOne({_id: orderRes.insertedId})

        //pobrana rezerwacje dodajemy rowniez do listy rezerwacji naszego uzytkownika
        await clientsCollection.updateOne(
            {_id: new ObjectId(userId)},
            {$push: {history: orderToAdd}}
        );

        //usuwamy koszyk
        await cartsCollection.deleteOne({client_id: new ObjectId(userId)});


        return res.status(200).json({ success: true, message: 'Order made!' });
    }catch(error){
        console.error('Error clearing cart:', error);
        return res.status(500).json({ success: false, message: 'An error occurred while clearing the cart.' });   
    }

});


app.get('/orders', requireLogin, async (req, res) => {
    //z Sessions pobieramy ID naszego użytkownika żebyśmy wiedzieli kogo koszyk wyswietlic
    const userId = req.session.userId;


    //znajdz koszyk w kolekcji Carts o numerze clienta_id równym id naszego uzytkownika 
    const clients = await clientsCollection.findOne({_id: new ObjectId(userId)}); 

    const orders = clients.history;
    

    //przekaz tablice do pliku cart.pug
    res.render('orders', { orders: orders });
});


app.get('/admin', requireLogin, async (req,res) =>{

    //strona admina
    res.render('adminIndex');
});

app.get('/adminorders', requireLogin, async (req,res) =>{


    //znajdz zamowienia ktore oczekuja na dostawe
    const ordersPending = await ordersCollection.find({status: "pending"}).toArray();

    //potwierdz dostawe zamowiena
    const ordersDelivered = await ordersCollection.find({status: "delivered"}).toArray();


    res.render('adminOrders',{ordersPending: ordersPending, ordersDelivered: ordersDelivered});
});

app.get('/adminreservations' , requireLogin, async(req,res) => {

    //znajdz rezerwacje ktore nie sa anulowane
    const reservations = await reservationsCollection.find({isCanceled: 0}).toArray();

    const currentDate = new Date().toISOString().split('T')[0];

    //sprawdz czy rezerwacja nie jest w przeszlosci
    const upcomingReservations = reservations.filter(reservations => reservations.date >= currentDate);

    res.render('adminReservations',{reservations: upcomingReservations});
});

app.post('/deliverorder', requireLogin, async (req,res) =>{
    
    try{
        const {orderID, clientID} = req.body

        //ustaw order jako dostarczony
        await ordersCollection.updateOne(
            { _id: new ObjectId(orderID) },
            { $set: { status: "delivered" } }
        );

        //ustaw order w historii klienta jako delivered
        await clientsCollection.updateOne(
            {_id: new ObjectId(clientID), "history._id": new ObjectId(orderID)},
            {$set: {"history.$.status": "delivered"}}
        );

        return res.status(200).json({ success: true, message: 'Order delivered!' });
        
    }catch(error){
        console.error('Error delivering order:', error);
        return res.status(500).json({ success: false, message: 'An error occurred while delivering orderS.' });  
    }
    
});


const PORT = 8000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});



